import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { paginate, resolveSort } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { endOfDay, startOfDay } from '../analytics/report-utils';
import { ProductNotFoundException } from '../catalog/catalog-exceptions';
import { CustomersService } from '../customers/customers.service';
import { OutletNotFoundException } from '../customers/customers-exceptions';
import { AgentNotFoundException } from '../field/field-exceptions';
import { WarehouseNotFoundException } from '../stock/stock-exceptions';
import { StockService } from '../stock/stock.service';
import type { CancelOrderDto } from './dto/cancel-order.dto';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { ListOrdersQueryDto } from './dto/list-orders.query';
import {
  AmbiguousWarehouseException,
  CustomerBlockedException,
  EmptyOrderException,
  InvalidOrderTransitionException,
  PackagingMismatchException,
  PriceNotFoundException,
  SalesOrderNotFoundException,
} from './sales-exceptions';

// Customer/outlet/agent/warehouse are included alongside lines so the web
// UI (9.2 "/orders", "/orders/:id") can render a full row/card without an
// extra round-trip per order.
const ORDER_INCLUDE = {
  lines: { include: { product: true, packaging: true } },
  customer: { select: { id: true, name: true, code: true } },
  outlet: { select: { id: true, name: true } },
  agent: { select: { id: true, firstName: true, lastName: true } },
  warehouse: { select: { id: true, name: true } },
} satisfies Prisma.SalesOrderInclude;

@Injectable()
export class SalesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly customers: CustomersService,
    private readonly stock: StockService,
    private readonly docNumbering: DocumentNumberingService,
  ) {}

  async list(query: ListOrdersQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // SEC-023 (15.3): a SALES_AGENT only ever sees their own orders — this
    // overrides whatever `agentId` they passed, so they can't page through
    // the rest of the company's orders by guessing other agents' ids.
    const scopedAgentId = user.roles.includes('SALES_AGENT') ? user.id : query.agentId;
    const where: Prisma.SalesOrderWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(scopedAgentId ? { agentId: scopedAgentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
              ...(query.to ? { lte: endOfDay(new Date(query.to)) } : {}),
            },
          }
        : {}),
    };

    const orderBy = resolveSort<Prisma.SalesOrderOrderByWithRelationInput>(
      query,
      {
        number: (dir) => ({ number: dir }),
        createdAt: (dir) => ({ createdAt: dir }),
      },
      { createdAt: 'desc' },
    );

    const [data, total] = await Promise.all([
      tx.salesOrder.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.salesOrder.count({ where }),
    ]);

    return paginate(data.map(withTotal), total, query.page, query.pageSize);
  }

  async getById(id: string, user: AuthenticatedUser) {
    // SEC-023: same object-level scoping as list() — an agent requesting
    // another agent's order id gets the same "not found" as a bad id,
    // rather than leaking that the order exists.
    const scopedAgentId = user.roles.includes('SALES_AGENT') ? user.id : undefined;
    return withTotal(await this.getRawOrder(this.tenantPrisma.client, id, scopedAgentId));
  }

  /**
   * F-M04 / 8.1-8.2: server computes every line total (client never sends
   * one — otherwise a client could set its own price); 10.4 offline
   * idempotency — a resubmitted clientId returns the original order instead
   * of erroring. Every order just needs one plain confirm — there's no
   * credit-limit-driven approval tier (that whole workflow was removed).
   */
  async create(dto: CreateOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    if (dto.clientId) {
      const existing = await tx.salesOrder.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: ORDER_INCLUDE });
      if (existing) return withTotal(existing);
    }

    if (dto.lines.length === 0) throw new EmptyOrderException();

    const customer = await this.customers.findActiveOrThrow(tx, dto.customerId);
    if (customer.isBlocked) throw new CustomerBlockedException(customer.blockReason);

    const outletId = await this.resolveOutlet(tx, dto.customerId, dto.outletId);
    const warehouseId = await this.resolveWarehouse(tx, dto.warehouseId);
    const agentId = user.roles.includes('SALES_AGENT') ? user.id : await this.resolveAgent(tx, dto.agentId);

    const priceListId = customer.priceListId ?? (await this.defaultPriceListId(tx));

    const lines: {
      productId: string;
      packagingId: string;
      qty: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      discountPct: Prisma.Decimal;
      vatRate: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
    }[] = [];
    // Batch the three per-line lookups instead of issuing them inside the loop:
    // a 20-line order used to cost 60 sequential round-trips. The per-line
    // validation below still runs in `dto.lines` order and throws the exact
    // same exceptions, so error semantics are unchanged — only the fetching
    // is hoisted.
    const productIds = [...new Set(dto.lines.map((l) => l.productId))];
    const packagingIds = [...new Set(dto.lines.map((l) => l.packagingId))];

    const [productRows, packagingRows, priceRows] = await Promise.all([
      tx.product.findMany({ where: { id: { in: productIds }, deletedAt: null } }),
      tx.productPackaging.findMany({
        where: { id: { in: packagingIds }, productId: { in: productIds } },
      }),
      priceListId
        ? tx.priceListItem.findMany({ where: { priceListId, productId: { in: productIds } } })
        : Promise.resolve([]),
    ]);

    const productById = new Map(productRows.map((p) => [p.id, p]));
    // Keyed by packaging id *and* product id so a packaging belonging to a
    // different product still misses, exactly like the old `findFirst` filter.
    const packagingByIdProduct = new Map(packagingRows.map((p) => [`${p.id}:${p.productId}`, p]));
    const priceByProduct = new Map(priceRows.map((p) => [p.productId, p]));

    for (const lineDto of dto.lines) {
      const product = productById.get(lineDto.productId);
      if (!product) throw new ProductNotFoundException();

      const packaging = packagingByIdProduct.get(`${lineDto.packagingId}:${lineDto.productId}`);
      if (!packaging) throw new PackagingMismatchException();

      const priceListItem = priceByProduct.get(lineDto.productId) ?? null;
      if (!priceListItem) throw new PriceNotFoundException(lineDto.productId);

      const baseQty = new Prisma.Decimal(lineDto.qty).times(packaging.qtyInBaseUnit);
      const discountPct = new Prisma.Decimal(lineDto.discountPct ?? 0);
      const lineTotal = baseQty
        .times(priceListItem.price)
        .times(new Prisma.Decimal(1).minus(discountPct.dividedBy(100)))
        .times(new Prisma.Decimal(1).plus(product.vatRate.dividedBy(100)));

      lines.push({
        productId: product.id,
        packagingId: packaging.id,
        qty: baseQty,
        unitPrice: priceListItem.price,
        discountPct,
        vatRate: product.vatRate,
        lineTotal,
      });
    }

    const number = await this.docNumbering.next(tx, user.companyId, 'SO');
    let order;
    try {
      // Wrapped in a SAVEPOINT: a unique-violation below aborts the whole
      // surrounding request transaction at the Postgres level, and without
      // a savepoint to roll back to, the recovery findUnique further down
      // would itself fail (25P02) instead of finding the winner's order.
      order = await withSavepoint(tx, 'sales_order_create', () =>
        tx.salesOrder.create({
          data: {
            companyId: user.companyId,
            number,
            customerId: dto.customerId,
            outletId,
            agentId,
            warehouseId,
            status: OrderStatus.SUBMITTED,
            clientId: dto.clientId,
            note: dto.note,
            lines: { create: lines },
          },
          include: ORDER_INCLUDE,
        }),
      );
    } catch (err) {
      // The pre-check at the top of this method is only a fast path — under
      // a genuine concurrent double-submit of the same clientId (10.4: the
      // exact "flaky connection, client retries" scenario clientId exists
      // for), both requests can race past it and the loser hits this unique
      // violation. Return the winner's order instead of a raw 500.
      if (dto.clientId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await tx.salesOrder.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: ORDER_INCLUDE });
        if (existing) return withTotal(existing);
      }
      throw err;
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.create',
      entity: 'SalesOrder',
      entityId: order.id,
      newValue: toAuditJson(order),
    });

    return withTotal(order);
  }

  /**
   * SUBMITTED → CONFIRMED — a single plain confirm step, no approval tier.
   * Reserves stock per line (8.3) — if any line can't be reserved,
   * InsufficientStockException rolls back the whole transaction, so no
   * partial reservation is left behind.
   */
  async confirm(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrder(tx, id);

    if (order.status !== OrderStatus.SUBMITTED) {
      throw new InvalidOrderTransitionException(order.status, OrderStatus.CONFIRMED);
    }

    for (const line of order.lines) {
      await this.stock.reserve(tx, {
        companyId: user.companyId,
        productId: line.productId,
        warehouseId: order.warehouseId,
        qty: line.qty,
        refType: 'SalesOrder',
        refId: order.id,
      });
    }

    const updated = await tx.salesOrder.update({
      where: { id },
      data: { status: OrderStatus.CONFIRMED },
      include: ORDER_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.confirm',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson({ status: order.status }),
      newValue: toAuditJson({ status: OrderStatus.CONFIRMED }),
    });

    return withTotal(updated);
  }

  /**
   * CONFIRMED → DELIVERED (8.7: PICKING/SHIPPED skipped in MVP). Issues
   * stock (consumes the reservation) and creates the invoice — 6.6:
   * "MVP'da 1 order = 1 invoice soddalashtirilgan".
   */
  async deliver(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrder(tx, id);

    if (order.status !== OrderStatus.CONFIRMED) {
      throw new InvalidOrderTransitionException(order.status, OrderStatus.DELIVERED);
    }

    for (const line of order.lines) {
      await this.stock.issue(tx, {
        companyId: user.companyId,
        productId: line.productId,
        warehouseId: order.warehouseId,
        qty: line.qty,
        refType: 'SalesOrder',
        refId: order.id,
      });
    }

    const invoiceTotal = order.lines.reduce((sum, l) => sum.plus(l.lineTotal), new Prisma.Decimal(0));
    const invoiceNumber = await this.docNumbering.next(tx, user.companyId, 'INV');
    const invoice = await tx.invoice.create({
      data: {
        companyId: user.companyId,
        number: invoiceNumber,
        customerId: order.customerId,
        orderId: order.id,
        total: invoiceTotal,
        status: 'OPEN',
        lines: {
          create: order.lines.map((line) => ({
            productId: line.productId,
            qty: line.qty,
            unitPrice: line.unitPrice,
            vatRate: line.vatRate,
            lineTotal: line.lineTotal,
          })),
        },
      },
    });

    // 6.7 (schema, Payment section): Customer.cachedBalance is a projection
    // kept in step inside the same transaction as the ledger rows that move
    // it. A new Invoice raises the customer's debt exactly like a payment
    // lowers it (PaymentsService.create() recomputes it there), so it has to
    // be recomputed here too — otherwise the cached figure (customers list
    // `balance` sort, /sync/pull `balances` for the offline agent) stays
    // stale until that customer happens to pay something.
    const balance = await this.customers.getBalance(tx, order.customerId);
    await tx.customer.update({ where: { id: order.customerId }, data: { cachedBalance: balance } });

    const updated = await tx.salesOrder.update({
      where: { id },
      data: { status: OrderStatus.DELIVERED },
      include: ORDER_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.deliver',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson({ status: order.status }),
      newValue: toAuditJson({ status: OrderStatus.DELIVERED, invoiceId: invoice.id }),
    });

    return withTotal(updated);
  }

  /** DELIVERED → CLOSED — administrative close, no further side effects in MVP. */
  async close(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrder(tx, id);
    if (order.status !== OrderStatus.DELIVERED) {
      throw new InvalidOrderTransitionException(order.status, OrderStatus.CLOSED);
    }

    const updated = await tx.salesOrder.update({
      where: { id },
      data: { status: OrderStatus.CLOSED },
      include: ORDER_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.close',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson({ status: order.status }),
      newValue: toAuditJson({ status: OrderStatus.CLOSED }),
    });

    return withTotal(updated);
  }

  /** Releases any reservation (if CONFIRMED) — never allowed once DELIVERED/CLOSED. */
  async cancel(id: string, dto: CancelOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrder(tx, id);

    if (
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.CLOSED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new InvalidOrderTransitionException(order.status, OrderStatus.CANCELLED);
    }

    if (order.status === OrderStatus.CONFIRMED) {
      for (const line of order.lines) {
        await this.stock.release(tx, {
          companyId: user.companyId,
          productId: line.productId,
          warehouseId: order.warehouseId,
          qty: line.qty,
          refType: 'SalesOrder',
          refId: order.id,
        });
      }
    }

    const updated = await tx.salesOrder.update({
      where: { id },
      data: {
        status: OrderStatus.CANCELLED,
        note: dto.reason ? `${order.note ?? ''}\n[Bekor qilindi]: ${dto.reason}`.trim() : order.note,
      },
      include: ORDER_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.cancel',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson({ status: order.status }),
      newValue: toAuditJson({ status: OrderStatus.CANCELLED, reason: dto.reason }),
    });

    return withTotal(updated);
  }

  private async getRawOrder(tx: TenantClient, id: string, scopedAgentId?: string) {
    const order = await tx.salesOrder.findFirst({
      where: { id, ...(scopedAgentId ? { agentId: scopedAgentId } : {}) },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new SalesOrderNotFoundException();
    return order;
  }

  private async resolveOutlet(tx: TenantClient, customerId: string, outletId: string | undefined) {
    if (!outletId) return null;
    const outlet = await tx.outlet.findFirst({ where: { id: outletId, customerId, deletedAt: null } });
    if (!outlet) throw new OutletNotFoundException();
    return outlet.id;
  }

  /**
   * agentId stays optional (an office-entered order needn't have one), but a
   * supplied one is validated like resolveOutlet/resolveWarehouse — FK checks
   * bypass RLS, so an unvalidated id is both a raw P2003 500 and a way to
   * attach another tenant's user to the order.
   */
  private async resolveAgent(tx: TenantClient, agentId: string | undefined) {
    if (!agentId) return null;
    const agent = await tx.user.findFirst({ where: { id: agentId, isActive: true } });
    if (!agent) throw new AgentNotFoundException();
    return agent.id;
  }

  private async resolveWarehouse(tx: TenantClient, warehouseId: string | undefined) {
    if (warehouseId) {
      // An explicit warehouseId is client-supplied — validate it the same
      // way resolveOutlet() above validates outletId, instead of trusting
      // it straight into the order (a nonexistent/deactivated/cross-tenant
      // id would otherwise only surface later as a raw FK-violation 500, or
      // an order silently created against a deactivated warehouse).
      const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, isActive: true } });
      if (!warehouse) throw new WarehouseNotFoundException();
      return warehouse.id;
    }
    const warehouses = await tx.warehouse.findMany({ where: { isActive: true }, take: 2 });
    if (warehouses.length === 1) return warehouses[0]!.id;
    if (warehouses.length === 0) {
      // Single-warehouse-per-company model, no "create a warehouse" UI —
      // provision it lazily on first use, same as defaultPriceListId below.
      const created = await tx.warehouse.create({
        data: { companyId: this.tenantPrisma.companyId, name: 'Asosiy ombor' },
      });
      return created.id;
    }
    throw new AmbiguousWarehouseException();
  }

  private async defaultPriceListId(tx: TenantClient) {
    const priceList = await tx.priceList.findFirst({ where: { isDefault: true } });
    if (priceList) return priceList.id;
    // Pricing is now managed as a single implicit price-per-product (set
    // from the product form) rather than a user-facing "Narx ro'yxatlari"
    // module, so a fresh company never goes through a step that creates
    // this row explicitly — provision it lazily on first use instead of
    // failing every order with PriceNotFoundException.
    const created = await tx.priceList.create({
      data: { companyId: this.tenantPrisma.companyId, name: 'Narx', isDefault: true },
    });
    return created.id;
  }
}

function withTotal<T extends { lines: { lineTotal: Prisma.Decimal }[] }>(order: T) {
  return { ...order, total: order.lines.reduce((sum, l) => sum.plus(l.lineTotal), new Prisma.Decimal(0)) };
}
