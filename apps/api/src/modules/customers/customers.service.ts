import { Injectable } from '@nestjs/common';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import { auditRejection, type RejectionAuditEntry } from '../../common/audit/rejection-audit';
import { PermissionDeniedException } from '../../common/auth/auth-exceptions';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AppException } from '../../common/errors/app-exception';
import { paginate, resolveSort } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { POSTED_PAYMENT_WHERE, VALID_ALLOCATION_WHERE, paymentPostedAt } from '../finance/ledger-filters';
import {
  CustomerAlreadyBlockedException,
  CustomerCodeConflictOnRestoreException,
  CustomerHasCreditBalanceException,
  CustomerHasOpenObligationsException,
  CustomerHasPendingHandoverException,
  CustomerHasOutstandingBalanceException,
  CustomerNotBlockedException,
  CustomerNotFoundException,
  DuplicateCustomerCodeException,
  PriceListNotFoundForCustomerException,
  type CustomerDeleteBlockers,
} from './customers-exceptions';
import type { BlockCustomerDto } from './dto/block-customer.dto';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { ListCustomersQueryDto } from './dto/list-customers.query';
import type { UpdateCustomerDto } from './dto/update-customer.dto';
import { findCustomerDuplicates, findOutletLocationDuplicates, type DuplicateWarning } from './duplicate-detection';

/** ADR-061c: order statuses that keep a customer undeletable (CLOSED/CANCELLED are terminal). */
const DELETE_BLOCKING_ORDER_STATUSES = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'SHIPPED', 'DELIVERED'] as const;

@Injectable()
export class CustomersService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Public for other modules (e.g. Sales, 11.2 "faqat servis interfeysi orqali") that need to validate a customerId without the full detail-view cost of getById(). */
  async findActiveOrThrow(tx: TenantClient, customerId: string) {
    const customer = await tx.customer.findFirst({ where: { id: customerId, deletedAt: null } });
    if (!customer) throw new CustomerNotFoundException();
    return customer;
  }

  /**
   * Customer row lock (`SELECT ... FOR UPDATE`) — the single lock every ledger
   * writer (payments create/allocate/reverse, SalesService.deliver) and
   * remove() take on a customer. Lock order (deadlock-free, see
   * sales.service.test "customer lock order"):
   *   Payment → Customer → Invoice  (PaymentsService)
   *   SalesOrder → Customer → StockLevel → Invoice  (SalesService.deliver)
   *   Customer only  (remove/update/block)
   * Nothing locks Customer before Payment/SalesOrder, nor StockLevel/Invoice
   * before Customer, so the graph is acyclic. Re-entrant within one tx.
   */
  async lockForUpdate(tx: TenantClient, customerId: string): Promise<void> {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Customer" WHERE id = ${customerId}::uuid FOR UPDATE`);
  }

  /**
   * Lock, THEN a fresh deletedAt read: a concurrent remove() holds the same
   * lock, so either it commits first (we see deletedAt → CustomerNotFound) or
   * we commit first (its ledger read sees our new row → balance ≠ 0, refused).
   */
  async lockActiveOrThrow(tx: TenantClient, customerId: string) {
    await this.lockForUpdate(tx, customerId);
    return this.findActiveOrThrow(tx, customerId);
  }

  /**
   * FOR KEY SHARE (what a child-row FK check takes anyway), then a fresh
   * deletedAt read — for writers that only reference the customer
   * (SalesService.create): conflicts with FOR UPDATE holders (ledger writers,
   * remove()) but not with each other. Must precede any DocumentCounter lock.
   */
  async lockKeyShareActiveOrThrow(tx: TenantClient, customerId: string) {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Customer" WHERE id = ${customerId}::uuid FOR KEY SHARE`);
    return this.findActiveOrThrow(tx, customerId);
  }

  /**
   * SEC-023 (15.3): "agent faqat o'z mijozini ko'radi" — a SALES_AGENT's
   * visible customers are those reachable through their own routes, their
   * own orders, or their own visits. Other roles (SALES_DIRECTOR, OWNER,
   * WAREHOUSE, CASHIER, ACCOUNTANT) are unrestricted here; this is only ever
   * applied when the caller holds the SALES_AGENT role.
   *
   * Public because Finance (Invoices) scopes its own rows through the
   * customer relation using exactly this predicate — modules reach each
   * other only via service interfaces (11.2), so the rule stays defined once.
   */
  agentScope(agentId: string): Prisma.CustomerWhereInput {
    return {
      OR: [
        { outlets: { some: { routeStops: { some: { route: { agentId } } } } } },
        { salesOrders: { some: { agentId } } },
        { outlets: { some: { visits: { some: { agentId } } } } },
      ],
    };
  }

  async list(query: ListCustomersQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const isAgent = user.roles.includes('SALES_AGENT');
    // ADR-061: the deleted list is the restore workbench — same grant as restore.
    if (query.deleted && !user.permissions.includes('customers.restore')) {
      throw auditRejection(
        this.tenantPrisma,
        this.auditLog,
        { companyId: user.companyId, userId: user.id, action: 'customer.list_deleted', entity: 'User', entityId: user.id },
        new PermissionDeniedException('customers.restore'),
      );
    }
    const where: Prisma.CustomerWhereInput = {
      deletedAt: query.deleted ? { not: null } : null,
      ...(query.isBlocked !== undefined ? { isBlocked: query.isBlocked } : {}),
      // Combined via AND (not spread) so the agent scope's own OR doesn't
      // clobber the search OR below — two top-level `OR` keys in one object
      // would silently drop the first.
      AND: [
        ...(isAgent ? [this.agentScope(user.id)] : []),
        ...(query.search
          ? [
              {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' as const } },
                  { code: { contains: query.search, mode: 'insensitive' as const } },
                  { phone: { contains: query.search, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };

    const orderBy = resolveSort<Prisma.CustomerOrderByWithRelationInput>(
      query,
      {
        code: (dir) => ({ code: dir }),
        name: (dir) => ({ name: dir }),
        balance: (dir) => ({ cachedBalance: dir }),
      },
      { name: 'asc' },
    );

    const [data, total] = await Promise.all([
      tx.customer.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.customer.count({ where }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  /** Full customer card per 6.3: current debt, last 10 orders, last payment, visit history. */
  async getById(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const isAgent = user.roles.includes('SALES_AGENT');
    const customer = await tx.customer.findFirst({
      where: { id, deletedAt: null, ...(isAgent ? this.agentScope(user.id) : {}) },
      include: { outlets: { where: { deletedAt: null } }, priceList: true },
    });
    // Out-of-scope for this agent looks identical to nonexistent — same
    // exception either way, so the response never confirms another agent's
    // customer exists.
    if (!customer) throw new CustomerNotFoundException();

    const [{ balance, advance }, recentOrders, lastPayment, recentVisits] = await Promise.all([
      this.getLedger(tx, id),
      tx.salesOrder.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { lines: true },
      }),
      this.lastPostedPayment(tx, id),
      tx.visit.findMany({
        where: { outlet: { customerId: id } },
        orderBy: { startedAt: 'desc' },
        take: 10,
        include: { outlet: { select: { name: true } } },
      }),
    ]);

    return {
      ...customer,
      balance,
      advance: advance.toString(),
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        number: order.number,
        status: order.status,
        createdAt: order.createdAt,
        total: order.lines.reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0)),
      })),
      lastPayment,
      recentVisits,
    };
  }

  async create(dto: CreateCustomerDto, user: AuthenticatedUser): Promise<{ customer: unknown; warnings: DuplicateWarning[] }> {
    const tx = this.tenantPrisma.client;

    if (dto.priceListId) {
      const priceList = await tx.priceList.findFirst({ where: { id: dto.priceListId } });
      if (!priceList) throw new PriceListNotFoundForCustomerException();
    }

    const codeClash = await tx.customer.findFirst({ where: { code: dto.code, deletedAt: null } });
    if (codeClash) throw new DuplicateCustomerCodeException(dto.code);

    const warnings = await findCustomerDuplicates(tx, { name: dto.name, phone: dto.phone });

    const customer = await tx.customer.create({
      data: {
        companyId: user.companyId,
        code: dto.code,
        name: dto.name,
        phone: dto.phone,
        contactPerson: dto.contactPerson,
        priceListId: dto.priceListId,
        paymentTermDays: dto.paymentTermDays ?? 0,
        outlets: dto.outlets
          ? {
              create: dto.outlets.map((outlet) => ({
                companyId: user.companyId,
                name: outlet.name,
                type: outlet.type,
                address: outlet.address,
                latitude: outlet.latitude,
                longitude: outlet.longitude,
              })),
            }
          : undefined,
      },
      include: { outlets: true },
    });

    for (const outlet of customer.outlets) {
      if (outlet.latitude != null && outlet.longitude != null) {
        warnings.push(
          ...(await findOutletLocationDuplicates(tx, Number(outlet.latitude), Number(outlet.longitude), outlet.id)),
        );
      }
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'customer.create',
      entity: 'Customer',
      entityId: customer.id,
      newValue: toAuditJson(customer),
    });

    return { customer, warnings };
  }

  async update(id: string, dto: UpdateCustomerDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.customer.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new CustomerNotFoundException();

    if (dto.priceListId) {
      const priceList = await tx.priceList.findFirst({ where: { id: dto.priceListId } });
      if (!priceList) throw new PriceListNotFoundForCustomerException();
    }

    if (dto.code && dto.code !== before.code) {
      const clash = await tx.customer.findFirst({ where: { code: dto.code, deletedAt: null, NOT: { id } } });
      if (clash) throw new DuplicateCustomerCodeException(dto.code);
    }

    const warnings = await findCustomerDuplicates(
      tx,
      { name: dto.name ?? before.name, phone: dto.phone ?? before.phone },
      id,
    );

    const customer = await tx.customer.update({
      where: { id },
      data: {
        code: dto.code,
        name: dto.name,
        phone: dto.phone,
        contactPerson: dto.contactPerson,
        priceListId: dto.priceListId,
        paymentTermDays: dto.paymentTermDays,
      },
      include: { outlets: true },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'customer.update',
      entity: 'Customer',
      entityId: id,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(customer),
    });

    return { customer, warnings };
  }

  async block(id: string, dto: BlockCustomerDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.customer.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new CustomerNotFoundException();
    if (before.isBlocked) throw new CustomerAlreadyBlockedException();

    const customer = await tx.customer.update({
      where: { id },
      data: { isBlocked: true, blockReason: dto.reason },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'customer.block',
      entity: 'Customer',
      entityId: id,
      oldValue: toAuditJson({ isBlocked: before.isBlocked, blockReason: before.blockReason }),
      newValue: toAuditJson({ isBlocked: true, blockReason: dto.reason }),
    });

    return customer;
  }

  async unblock(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.customer.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new CustomerNotFoundException();
    if (!before.isBlocked) throw new CustomerNotBlockedException();

    const customer = await tx.customer.update({
      where: { id },
      data: { isBlocked: false, blockReason: null },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'customer.unblock',
      entity: 'Customer',
      entityId: id,
      oldValue: toAuditJson({ isBlocked: true, blockReason: before.blockReason }),
      newValue: toAuditJson({ isBlocked: false, blockReason: null }),
    });

    return customer;
  }

  /**
   * DELETE /customers/:id — soft delete, same shape as the other soft-deleting resources
   * and OutletsService.remove(): Customer carries `deletedAt`, and its orders /
   * invoices / payments keep pointing at the row, so it's never physically
   * removed. The `code` becomes reusable immediately thanks to the partial
   * unique index (schema comment on Customer).
   *
   * Refuses while the customer still owes money (6.7) — deleting them would
   * drop a live receivable out of every report that filters `deletedAt: null`.
   */
  async remove(id: string, user: AuthenticatedUser) {
    return this.auditedRejections(this.rejectionEntry(user, 'customer.delete', id), async () => {
      const tx = this.tenantPrisma.client;
      const exists = await tx.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      if (!exists) throw new CustomerNotFoundException();

      // Same customer-row lock ledger writers take (refreshCachedBalance), so the
      // balance below cannot change under us before the soft delete commits.
      // deletedAt is re-read AFTER the lock: a concurrent remove() that committed
      // while we waited must make this one fail (CustomerNotFound), not delete
      // and audit a second time. SalesService.create takes FOR KEY SHARE on the
      // same row, so an order either committed before this lock (counted below)
      // or waits and then sees deletedAt — no new lock, order unchanged.
      const before = await this.lockActiveOrThrow(tx, id);
      const { blockers, balance } = await this.deleteBlockers(tx, id);
      // ADR-029: PENDING_HANDOVER cash is outside the ledger; deleting now would make
      // accept fail with CustomerNotFound. Plain reads after the customer lock (no
      // payment/order lock taken here, so Payment -> Customer order is never inverted).
      if (blockers.pendingHandover > 0) throw new CustomerHasPendingHandoverException(blockers.pendingHandover, blockers);
      // Ledger (source of truth), not cachedBalance. Only exactly 0 may be deleted:
      // debt (> 0) and credit/advance owed back to the customer (< 0) both block.
      if (balance.greaterThan(0)) throw new CustomerHasOutstandingBalanceException(balance.toFixed(2), blockers);
      if (balance.lessThan(0)) throw new CustomerHasCreditBalanceException(balance.abs().toFixed(2), blockers);
      // ADR-061c: a debt and an advance that merely net to 0, or any non-terminal order, still block.
      if (Object.keys(blockers.orders).length > 0 || blockers.debt !== '0.00' || blockers.advance !== '0.00') {
        throw new CustomerHasOpenObligationsException(blockers);
      }

      const deletedAt = new Date();
      const customer = await tx.customer.update({ where: { id }, data: { deletedAt, isActive: false } });
      // Outlets are meaningless without their customer and every read path
      // filters them by `deletedAt: null` — cascade rather than leave orphans.
      // Their prior isActive goes into the audit so restore() can bring it back.
      const outlets = await tx.outlet.findMany({ where: { customerId: id, deletedAt: null }, select: { id: true, isActive: true }, orderBy: { id: 'asc' } });
      await tx.outlet.updateMany({ where: { customerId: id, deletedAt: null }, data: { deletedAt, isActive: false } });

      await this.auditLog.log(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: 'customer.delete',
        entity: 'Customer',
        entityId: id,
        oldValue: toAuditJson(before),
        newValue: toAuditJson({ deletedAt, outlets }),
      });

      return customer;
    });
  }

  /**
   * ADR-061: POST /customers/:id/restore (OWNER, `customers.restore`). Under the
   * same Customer FOR UPDATE lock as remove()/ledger writers. 404 when the row
   * is live or invisible (RLS: other tenant). A live customer holding the same
   * code is an explicit conflict (no auto-rename; also the partial unique index
   * P2002 for a concurrent create). isActive and each outlet's isActive come
   * from the latest `customer.delete` audit (fallback false = safest); only
   * outlets cascade-deleted with exactly the customer's deletedAt come back.
   */
  async restore(id: string, user: AuthenticatedUser) {
    return this.auditedRejections(this.rejectionEntry(user, 'customer.restore', id), async () => {
      const tx = this.tenantPrisma.client;
      await this.lockForUpdate(tx, id);
      const before = await tx.customer.findFirst({ where: { id, deletedAt: { not: null } } });
      if (!before?.deletedAt) throw new CustomerNotFoundException();
      const deletedAt = before.deletedAt;

      const clash = await tx.customer.findFirst({ where: { code: before.code, deletedAt: null, NOT: { id } }, select: { id: true } });
      if (clash) throw new CustomerCodeConflictOnRestoreException(before.code);

      const snapshot = await this.deleteSnapshot(tx, id);
      const isActive = snapshot.isActive ?? false;
      let customer;
      try {
        customer = await tx.customer.update({ where: { id }, data: { deletedAt: null, isActive } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new CustomerCodeConflictOnRestoreException(before.code);
        throw err;
      }

      const cascaded = await tx.outlet.findMany({ where: { customerId: id, deletedAt }, select: { id: true }, orderBy: { id: 'asc' } });
      const activeIds = cascaded.filter((o) => snapshot.activeOutletIds.has(o.id)).map((o) => o.id);
      const inactiveIds = cascaded.filter((o) => !snapshot.activeOutletIds.has(o.id)).map((o) => o.id);
      if (activeIds.length > 0) await tx.outlet.updateMany({ where: { id: { in: activeIds } }, data: { deletedAt: null, isActive: true } });
      if (inactiveIds.length > 0) await tx.outlet.updateMany({ where: { id: { in: inactiveIds } }, data: { deletedAt: null, isActive: false } });

      await this.auditLog.log(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: 'customer.restore',
        entity: 'Customer',
        entityId: id,
        oldValue: toAuditJson({ deletedAt, isActive: before.isActive }),
        newValue: toAuditJson({ deletedAt: null, isActive, restoredOutletIds: cascaded.map((o) => o.id) }),
      });
      return customer;
    });
  }

  /** ADR-061c: everything that still references the customer — read under the customer lock. */
  private async deleteBlockers(tx: TenantClient, id: string): Promise<{ blockers: CustomerDeleteBlockers; balance: Prisma.Decimal }> {
    const [pendingHandover, ledger, orderGroups] = await Promise.all([
      tx.payment.count({ where: { customerId: id, status: 'PENDING_HANDOVER' } }),
      this.getLedger(tx, id),
      tx.salesOrder.groupBy({
        by: ['status'],
        where: { customerId: id, status: { in: [...DELETE_BLOCKING_ORDER_STATUSES] } },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
    ]);
    const orders: Record<string, number> = {};
    for (const g of orderGroups) orders[g.status] = g._count._all;
    const debt = ledger.invoiced.minus(ledger.allocated);
    return { blockers: { orders, pendingHandover, debt: debt.toFixed(2), advance: ledger.advance.toFixed(2) }, balance: ledger.balance };
  }

  /** Prior isActive of the customer and its outlets, from the latest `customer.delete` audit row. */
  private async deleteSnapshot(tx: TenantClient, id: string): Promise<{ isActive?: boolean; activeOutletIds: Set<string> }> {
    const row = await tx.auditLog.findFirst({
      where: { action: 'customer.delete', entity: 'Customer', entityId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { oldValue: true, newValue: true },
    });
    const old = row?.oldValue as { isActive?: unknown } | null | undefined;
    const outlets = (row?.newValue as { outlets?: unknown } | null | undefined)?.outlets;
    const activeOutletIds = new Set<string>();
    if (Array.isArray(outlets)) {
      for (const o of outlets as Array<{ id?: unknown; isActive?: unknown }>) {
        if (typeof o?.id === 'string' && o.isActive === true) activeOutletIds.add(o.id);
      }
    }
    return { isActive: typeof old?.isActive === 'boolean' ? old.isActive : undefined, activeOutletIds };
  }

  private rejectionEntry(user: AuthenticatedUser, action: string, id: string): RejectionAuditEntry {
    return { companyId: user.companyId, userId: user.id, action, entity: 'Customer', entityId: id };
  }

  /** Any AppException from `fn` leaves one `<action>_rejected` audit row (own tx, after rollback), then is rethrown. */
  private async auditedRejections<T>(entry: RejectionAuditEntry, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppException) auditRejection(this.tenantPrisma, this.auditLog, entry, err);
      throw err;
    }
  }

  /** 7.2 "GET /customers/:id/balance" — standalone lookup, cheaper than the full getById() card. */
  async getCustomerBalance(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const isAgent = user.roles.includes('SALES_AGENT');
    const customer = await tx.customer.findFirst({
      where: { id, deletedAt: null, ...(isAgent ? this.agentScope(user.id) : {}) },
      select: { id: true },
    });
    if (!customer) throw new CustomerNotFoundException();
    const { balance, advance } = await this.getLedger(tx, id);
    return { customerId: id, balance, advance: advance.toString() };
  }

  /**
   * ADR-029: "oxirgi to'lov" = latest POSTED payment by its posting date
   * coalesce(handoverAt, createdAt) (ledger-filters paymentPostedAt). Prisma
   * cannot ORDER BY a coalesce, so take the newest of each branch and compare.
   */
  private async lastPostedPayment(tx: TenantClient, customerId: string) {
    const [accepted, direct] = await Promise.all([
      tx.payment.findFirst({ where: { customerId, ...POSTED_PAYMENT_WHERE, handoverAt: { not: null } }, orderBy: [{ handoverAt: 'desc' }, { id: 'desc' }] }),
      tx.payment.findFirst({ where: { customerId, ...POSTED_PAYMENT_WHERE, handoverAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    ]);
    if (!accepted || !direct) return accepted ?? direct;
    return paymentPostedAt(accepted) >= paymentPostedAt(direct) ? accepted : direct;
  }

  /** Customer balance only — see getLedger() for the formula. */
  async getBalance(tx: TenantClient, customerId: string): Promise<Prisma.Decimal> {
    return (await this.getLedger(tx, customerId)).balance;
  }

  /**
   * §6.5 / F2.1: balance = Σ live invoices − Σ valid allocations to them −
   * advance, where advance = Σ POSTED payments − their valid allocations to
   * live invoices (paymentAdvanceOf, summed). REVERSED payments count nowhere.
   * Over-payment ⇒ negative balance (customer credit). Decimal throughout.
   * Public: Payments/Sales recompute cachedBalance from this (11.2).
   */
  async getLedger(
    tx: TenantClient,
    customerId: string,
  ): Promise<{ invoiced: Prisma.Decimal; allocated: Prisma.Decimal; advance: Prisma.Decimal; balance: Prisma.Decimal }> {
    const liveInvoice = { status: { not: 'CANCELLED' as const } };
    const [invoiceAgg, allocatedAgg, postedAgg, appliedOwnAgg] = await Promise.all([
      tx.invoice.aggregate({ where: { customerId, ...liveInvoice }, _sum: { total: true } }),
      tx.paymentAllocation.aggregate({
        where: { invoice: { customerId, ...liveInvoice }, ...VALID_ALLOCATION_WHERE },
        _sum: { amount: true },
      }),
      tx.payment.aggregate({ where: { customerId, ...POSTED_PAYMENT_WHERE }, _sum: { amount: true } }),
      tx.paymentAllocation.aggregate({
        where: { invoice: liveInvoice, payment: { customerId, ...POSTED_PAYMENT_WHERE } },
        _sum: { amount: true },
      }),
    ]);

    const zero = new Prisma.Decimal(0);
    const invoiced = invoiceAgg._sum.total ?? zero;
    const allocated = allocatedAgg._sum.amount ?? zero;
    const advance = (postedAgg._sum.amount ?? zero).minus(appliedOwnAgg._sum.amount ?? zero);
    return { invoiced, allocated, advance, balance: invoiced.minus(allocated).minus(advance) };
  }
}
