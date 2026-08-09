import { Injectable } from '@nestjs/common';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { paginate, resolveSort } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  CustomerAlreadyBlockedException,
  CustomerHasOutstandingBalanceException,
  CustomerNotBlockedException,
  CustomerNotFoundException,
  DuplicateCustomerCodeException,
  PriceListNotFoundForCustomerException,
} from './customers-exceptions';
import type { BlockCustomerDto } from './dto/block-customer.dto';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { ListCustomersQueryDto } from './dto/list-customers.query';
import type { UpdateCustomerDto } from './dto/update-customer.dto';
import { findCustomerDuplicates, findOutletLocationDuplicates, type DuplicateWarning } from './duplicate-detection';

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
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
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

    const [balance, recentOrders, lastPayment, recentVisits] = await Promise.all([
      this.getBalance(tx, id),
      tx.salesOrder.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { lines: true },
      }),
      tx.payment.findFirst({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
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
   * DELETE /customers/:id — soft delete, same shape as SuppliersService.remove()
   * and OutletsService.remove(): Customer carries `deletedAt`, and its orders /
   * invoices / payments keep pointing at the row, so it's never physically
   * removed. The `code` becomes reusable immediately thanks to the partial
   * unique index (schema comment on Customer).
   *
   * Refuses while the customer still owes money (6.7) — deleting them would
   * drop a live receivable out of every report that filters `deletedAt: null`.
   */
  async remove(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.customer.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new CustomerNotFoundException();

    const balance = await this.getBalance(tx, id);
    if (!balance.isZero()) throw new CustomerHasOutstandingBalanceException(balance.toFixed(2));

    const deletedAt = new Date();
    const customer = await tx.customer.update({ where: { id }, data: { deletedAt, isActive: false } });
    // Outlets are meaningless without their customer and every read path
    // filters them by `deletedAt: null` — cascade rather than leave orphans.
    await tx.outlet.updateMany({ where: { customerId: id, deletedAt: null }, data: { deletedAt, isActive: false } });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'customer.delete',
      entity: 'Customer',
      entityId: id,
      oldValue: toAuditJson(before),
    });

    return customer;
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
    const balance = await this.getBalance(tx, id);
    return { customerId: id, balance };
  }

  /**
   * 6.7: Balans = Σ(Invoice.total) − Σ(PaymentAllocation.amount), cancelled
   * invoices excluded. Decimal throughout — never Float. Public: the
   * Payments module calls this to compute allocation against open invoices
   * — modules only reach each other via service interfaces (11.2).
   */
  async getBalance(tx: TenantClient, customerId: string): Promise<Prisma.Decimal> {
    const [invoiceAgg, paymentAgg] = await Promise.all([
      tx.invoice.aggregate({ where: { customerId, status: { not: 'CANCELLED' } }, _sum: { total: true } }),
      tx.paymentAllocation.aggregate({
        where: { invoice: { customerId, status: { not: 'CANCELLED' } } },
        _sum: { amount: true },
      }),
    ]);

    const totalInvoiced = invoiceAgg._sum.total ?? new Prisma.Decimal(0);
    const totalPaid = paymentAgg._sum.amount ?? new Prisma.Decimal(0);
    return totalInvoiced.minus(totalPaid);
  }
}
