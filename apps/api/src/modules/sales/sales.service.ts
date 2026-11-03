import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { assertClientIdReplayAllowed } from '../../common/idempotency/client-id-replay';
import { OrderStatus, Prisma, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import { auditRejection } from '../../common/audit/rejection-audit';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { paginate, resolveSort } from '../../common/pagination/pagination.dto';
import { TenantContext } from '../../common/tenant/tenant-context';
import { setWriterLockTimeout } from '../../common/tenant/lock-timeout';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { endOfDay, startOfDay } from '../analytics/report-utils';
import { ProductNotFoundException } from '../catalog/catalog-exceptions';
import { CustomersService } from '../customers/customers.service';
import { OutletNotFoundException } from '../customers/customers-exceptions';
import { AgentNotFoundException } from '../field/field-exceptions';
import { NotificationsService } from '../notifications/notifications.service';
import { WarehouseNotFoundException } from '../stock/stock-exceptions';
import { StockService } from '../stock/stock.service';
import type { AssignCourierDto } from './dto/assign-courier.dto';
import type { CancelOrderDto } from './dto/cancel-order.dto';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { DeliverOrderDto, DeliverOrderLineDto } from './dto/deliver-order.dto';
import type { ListOrdersQueryDto } from './dto/list-orders.query';
import type { HandoverOrderDto } from './dto/handover-order.dto';
import type { ReturnToWarehouseDto } from './dto/return-to-warehouse.dto';
import { isDeliveredQtyCheckViolation } from './delivered-qty-check';
import { assertNotBelowMinPrice, assertQtyPrecision } from './order-line-guards';
import { calcLineTotal, deliveredLineTotal, orderTotal, roundLineTotal, type OrderLineAmounts } from './line-total';
import {
  AmbiguousWarehouseException,
  CourierNotFoundException,
  CourierAssignmentForbiddenException,
  CourierAssignInvalidStatusException,
  HandoverCourierMismatchException,
  HandoverCourierRequiredException,
  HandoverInvalidStatusException,
  OrderAlreadyHandedOverException,
  OrderHandoverRequiredException,
  CustomerBlockedException,
  DeliveryLinesMismatchException,
  EmptyDeliveryException,
  EmptyOrderException,
  InvalidDeliveredQtyException,
  InvalidOrderTransitionException,
  OrderNotAssignedToCourierException,
  OrderAlreadyInvoicedException,
  OrderShippedRequiresReturnException,
  OverDeliveryException,
  PackagingMismatchException,
  PartialDeliveryNotAllowedException,
  PriceChangedException,
  PriceNotFoundException,
  ReturnToWarehouseInvalidStatusException,
  SalesOrderNotFoundException,
  type PriceChangedLine,
} from './sales-exceptions';

// Customer/outlet/agent/warehouse/courier are included alongside lines so
// the web UI (9.2 "/orders", "/orders/:id") can render a full row/card
// without an extra round-trip per order. The courier carries `phone` on top
// of the agent's fields because the warehouse/cashier screens need to be able
// to call the person currently holding the goods.
const ORDER_INCLUDE = {
  lines: { include: { product: true, packaging: true } },
  // `phone`/`address` are here for the courier Mini App screen, which is
  // online-only (a courier syncs no customer data to the device) and so has
  // no other source for "who to call / where to drop it off". Both nullable.
  customer: { select: { id: true, name: true, code: true, phone: true } },
  outlet: { select: { id: true, name: true, address: true } },
  agent: { select: { id: true, firstName: true, lastName: true } },
  warehouse: { select: { id: true, name: true } },
  courier: { select: { id: true, firstName: true, lastName: true, phone: true } },
} satisfies Prisma.SalesOrderInclude;

/**
 * Roles that may act on any order in the tenant, whoever is carrying it.
 * A user holding one of these *and* COURIER (a warehouse keeper who also does
 * runs) keeps the wide view — the self-scoping below is for the courier who
 * has no other role, i.e. the Mini App session.
 */
const ORDER_SUPERVISOR_ROLES = ['OWNER', 'SALES_DIRECTOR', 'WAREHOUSE'];

/** SEC-023, courier half: a courier-only session is confined to its own deliveries, exactly as a SALES_AGENT is to its own orders. */
function isCourierOnly(user: AuthenticatedUser): boolean {
  return user.roles.includes('COURIER') && !user.roles.some((role) => ORDER_SUPERVISOR_ROLES.includes(role));
}

/**
 * Every path that locks more than one StockLevel (reserve/release/issue)
 * walks the order lines in productId order, so two transactions sharing
 * products always take those row locks in the same order — no deadlock.
 * Array.prototype.sort is stable, so same-product lines keep their order.
 */
function sortByProduct<T extends { productId: string }>(lines: readonly T[]): T[] {
  return [...lines].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );
}

type DeliverableLine = {
  id: string;
  productId: string;
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPct: Prisma.Decimal;
  vatRate: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
};

type DeliveryPlanItem<L extends DeliverableLine> = {
  line: L;
  deliveredQty: Prisma.Decimal;
  releasedQty: Prisma.Decimal;
};

/**
 * F2.4: turns the optional `lines` body into a per-line (delivered, released)
 * plan, sorted by productId. No body ⇒ full delivery of every line. With a
 * body, every order line must be listed exactly once and 0 ≤ deliveredQty ≤ qty
 * (3 dp max); at least one line must deliver something. Pure — throws before
 * any write.
 */
function resolveDeliveryPlan<L extends DeliverableLine>(
  lines: readonly L[],
  requested: readonly DeliverOrderLineDto[] | undefined,
): DeliveryPlanItem<L>[] {
  const zero = new Prisma.Decimal(0);
  if (!requested) {
    return sortByProduct(lines).map((line) => ({
      line,
      deliveredQty: line.qty,
      releasedQty: zero,
    }));
  }

  const lineIds = new Set(lines.map((l) => l.id));
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  const unknown: string[] = [];
  for (const r of requested) {
    if (!lineIds.has(r.lineId)) unknown.push(r.lineId);
    else if (seen.has(r.lineId)) duplicate.add(r.lineId);
    seen.add(r.lineId);
  }
  const missing = lines.filter((l) => !seen.has(l.id)).map((l) => l.id);
  if (unknown.length || duplicate.size || missing.length) {
    throw new DeliveryLinesMismatchException({ unknown, duplicate: [...duplicate], missing });
  }

  const requestedById = new Map(requested.map((r) => [r.lineId, r.deliveredQty]));
  const plan = sortByProduct(lines).map((line) => {
    const raw = requestedById.get(line.id)!;
    let deliveredQty: Prisma.Decimal;
    try {
      deliveredQty = new Prisma.Decimal(raw);
    } catch {
      throw new InvalidDeliveredQtyException(line.id, String(raw));
    }
    if (!deliveredQty.isFinite() || deliveredQty.lessThan(0) || deliveredQty.decimalPlaces() > 3) {
      throw new InvalidDeliveredQtyException(line.id, String(raw));
    }
    if (deliveredQty.greaterThan(line.qty)) {
      throw new OverDeliveryException(line.id, line.qty.toString(), deliveredQty.toString());
    }
    return { line, deliveredQty, releasedQty: line.qty.minus(deliveredQty) };
  });

  if (plan.every((p) => p.deliveredQty.isZero())) throw new EmptyDeliveryException();
  return plan;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly customers: CustomersService,
    private readonly stock: StockService,
    private readonly docNumbering: DocumentNumberingService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: ListOrdersQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // SEC-023 (15.3): a SALES_AGENT only ever sees their own orders — this
    // overrides whatever `agentId` they passed, so they can't page through
    // the rest of the company's orders by guessing other agents' ids.
    const scopedAgentId = user.roles.includes('SALES_AGENT') ? user.id : query.agentId;
    // Same override for a courier-only session: it sees the orders handed to
    // it and nothing else, so `courierId` can't be used to browse the
    // company's whole order book (with customers, prices and totals).
    const scopedCourierId = isCourierOnly(user) ? user.id : query.courierId;
    const where: Prisma.SalesOrderWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(scopedAgentId ? { agentId: scopedAgentId } : {}),
      ...(scopedCourierId ? { courierId: scopedCourierId } : {}),
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
    const scope = {
      ...(user.roles.includes('SALES_AGENT') ? { agentId: user.id } : {}),
      ...(isCourierOnly(user) ? { courierId: user.id } : {}),
    };
    return withTotal(await this.getRawOrder(this.tenantPrisma.client, id, scope));
  }

  /**
   * F-M04 / 8.1-8.2: server computes every line total (client never sends
   * one — otherwise a client could set its own price); 10.4 offline
   * idempotency — a resubmitted clientId returns the original order instead
   * of erroring. Every order just needs one plain confirm — there's no
   * credit-limit-driven approval tier (that whole workflow was removed).
   */
  async create(dto: CreateOrderDto, user: AuthenticatedUser) {
    // POST /orders: lock wait > 2 s -> 55P03 -> 503 SERVICE_BUSY (sync push sets its own per document).
    await setWriterLockTimeout(this.tenantPrisma.client);
    return (await this.createWithOutcome(dto, user)).order;
  }

  /**
   * create() plus whether *this call* inserted the order (`created: false`
   * = an existing order was returned for the same clientId, either via the
   * fast-path lookup or the P2002 race recovery) — what offline sync needs
   * to report ACCEPTED vs DUPLICATE exactly, even under a concurrent
   * double-submit.
   *
   * F4: a line with `expectedUnitPrice` that differs from the server price
   * throws PriceChangedException *before* anything is written or a document
   * number is consumed. An existing clientId short-circuits first, so a
   * retried, already-accepted order stays DUPLICATE even if the price list
   * changed since.
   */
  async createWithOutcome(dto: CreateOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    // P0: courierId ⇒ CONFIRMED + reservation + courier attached, i.e. confirm()'s
    // effect (needs `orders.update`) plus the courier assignment (needs
    // `orders.assignCourier`). Never SHIPPED: that is handover() only (ADR-069/070).
    // BOTH are required; checked before any read/write (covers /sync/push).
    if (
      dto.courierId &&
      !(user.permissions.includes('orders.update') && user.permissions.includes('orders.assignCourier'))
    ) {
      // SEC-054: 403 is audited in its own tx after the rollback (ADR-061), also on /sync/push.
      throw auditRejection(
        this.tenantPrisma,
        this.auditLog,
        { companyId: user.companyId, userId: user.id, action: 'order.create_with_courier', entity: 'User', entityId: user.id },
        new CourierAssignmentForbiddenException(),
        { requiredPermissions: 'orders.update,orders.assignCourier' },
      );
    }

    if (dto.clientId) {
      const existing = await tx.salesOrder.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: ORDER_INCLUDE });
      if (existing) {
        assertClientIdReplayAllowed(existing.agentId, user);
        return { order: withTotal(existing), created: false };
      }
    }

    if (dto.lines.length === 0) throw new EmptyOrderException();

    // F7 40P01: the SalesOrder INSERT's FK check takes FOR KEY SHARE on the
    // customer row. Taken there — AFTER the SO counter — it waited on a sync
    // push holding Customer FOR UPDATE while that push waited on our counter.
    // Take the same (weakest) lock up front instead, before any counter, per
    // the global order in DocumentNumberingService; fresh deletedAt read after.
    const customer = await this.customers.lockKeyShareActiveOrThrow(tx, dto.customerId);
    if (customer.isBlocked) throw new CustomerBlockedException(customer.blockReason);

    const outletId = await this.resolveOutlet(tx, dto.customerId, dto.outletId);
    const warehouseId = await this.resolveWarehouse(tx, dto.warehouseId);
    const agentId = user.roles.includes('SALES_AGENT') ? user.id : await this.resolveAgent(tx, dto.agentId);
    // A courierId known up front = confirm() + assignCourier() in one step:
    // CONFIRMED with the courier attached and stock reserved. The physical
    // hand-over (→ SHIPPED) is a separate handover() by `orders.dispatch` (ADR-069/070).
    const courierId = dto.courierId ? await this.resolveCourier(tx, dto.courierId) : null;

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
    const priceChanges: PriceChangedLine[] = [];
    let expectedTotal = new Prisma.Decimal(0);
    let serverTotal = new Prisma.Decimal(0);

    for (const [lineIndex, lineDto] of dto.lines.entries()) {
      const product = productById.get(lineDto.productId);
      if (!product) throw new ProductNotFoundException();

      const packaging = packagingByIdProduct.get(`${lineDto.packagingId}:${lineDto.productId}`);
      if (!packaging) throw new PackagingMismatchException();

      const priceListItem = priceByProduct.get(lineDto.productId) ?? null;
      if (!priceListItem) throw new PriceNotFoundException(lineDto.productId);

      // ADR-059a: reject (never round) qty finer than the Decimal(18,3) column.
      const enteredQty = new Prisma.Decimal(lineDto.qty);
      const baseQty = enteredQty.times(packaging.qtyInBaseUnit);
      assertQtyPrecision({ productId: product.id, packagingId: packaging.id, qty: enteredQty, qtyInBaseUnit: packaging.qtyInBaseUnit, baseQty });
      const discountPct = new Prisma.Decimal(lineDto.discountPct ?? 0);
      // ADR-059b: server price after discount must not go below minPrice.
      assertNotBelowMinPrice({ productId: product.id, unitPrice: priceListItem.price, discountPct, minPrice: product.minPrice });
      const lineTotal = calcLineTotal(baseQty, priceListItem.price, discountPct, product.vatRate);

      // F4: compared as Decimal ("10000" == "10000.00"); no tolerance.
      const expectedUnitPrice = lineDto.expectedUnitPrice !== undefined ? new Prisma.Decimal(lineDto.expectedUnitPrice) : null;
      // Informational only (the trigger is the unit-price compare below): Σ of
      // per-line totals rounded like the stored numeric(18,2) lineTotal, so it
      // equals the total of the order created at the server price (ADR-059).
      serverTotal = serverTotal.plus(roundLineTotal(lineTotal));
      if (expectedUnitPrice && !expectedUnitPrice.equals(priceListItem.price)) {
        priceChanges.push({
          lineIndex,
          productId: product.id,
          packagingId: packaging.id,
          expectedUnitPrice: expectedUnitPrice.toFixed(2),
          serverUnitPrice: priceListItem.price.toFixed(2),
        });
        expectedTotal = expectedTotal.plus(roundLineTotal(calcLineTotal(baseQty, expectedUnitPrice, discountPct, product.vatRate)));
      } else {
        expectedTotal = expectedTotal.plus(roundLineTotal(lineTotal));
      }

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

    if (priceChanges.length > 0) {
      throw new PriceChangedException({ lines: priceChanges, expectedTotal: expectedTotal.toFixed(2), serverTotal: serverTotal.toFixed(2) });
    }

    // F7 late counter: INSERT under a unique placeholder number (invisible to
    // other txs until COMMIT), reserve, and only then take the hot SO counter
    // row lock — held now just for one UPDATE + audit, not the INSERT/re-read/
    // reservation. Rolled back with the tx => no gap; TMP- never leaves this tx.
    const placeholderNumber = `TMP-${randomUUID()}`;
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
            number: placeholderNumber,
            customerId: dto.customerId,
            outletId,
            agentId,
            warehouseId,
            courierId,
            status: courierId ? OrderStatus.CONFIRMED : OrderStatus.SUBMITTED,
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
        if (existing) {
          assertClientIdReplayAllowed(existing.agentId, user);
          return { order: withTotal(existing), created: false };
        }
      }
      throw err;
    }

    if (courierId) {
      // Jumping straight to CONFIRMED skips confirm()'s usual reservation
      // step, but deliver() still expects one to consume (stock.issue()
      // decrements `reserved`) — reserve here so that invariant holds.
      await this.reserveOrderStock(tx, order, user);
    }

    // Counter LAST (global lock order, DocumentNumberingService step 5): after
    // every row lock above. Only the own (uncommitted) SalesOrder row is
    // touched after it; FK columns are unchanged, so no new KEY SHARE.
    const number = await this.docNumbering.next(tx, user.companyId, 'SO');
    const renumbered = await tx.salesOrder.update({ where: { id: order.id }, data: { number }, select: { number: true, updatedAt: true } });
    order = { ...order, ...renumbered };

    if (courierId) await this.scheduleCourierAssignedNotification(tx, courierId, order.number, user.companyId);

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.create',
      entity: 'SalesOrder',
      entityId: order.id,
      newValue: toAuditJson(order),
    });

    return { order: withTotal(order), created: true };
  }

  /**
   * SUBMITTED → CONFIRMED — a single plain confirm step, no approval tier.
   * Reserves stock per line (8.3) — if any line can't be reserved,
   * InsufficientStockException rolls back the whole transaction, so no
   * partial reservation is left behind.
   */
  async confirm(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);

    if (order.status !== OrderStatus.SUBMITTED) {
      throw new InvalidOrderTransitionException(order.status, OrderStatus.CONFIRMED);
    }

    // ADR-059b: re-check against the CURRENT minPrice; reject, never reprice.
    await this.assertLinesNotBelowMinPrice(tx, order.lines);
    await this.reserveOrderStock(tx, order, user);

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
   * CONFIRMED (no courier) → DELIVERED, or SHIPPED → DELIVERED for a
   * courier-delivered order ("yetkazilmoqda" → "yetkazildi") — the plain
   * PICKING step is still skipped in MVP (8.7). A CONFIRMED order with a
   * courier attached must be handed over first (ADR-069/070) → 409.
   * Issues stock (consumes the reservation, made either by confirm()
   * or up front by create() for a courier order) and
   * creates the invoice — 6.6: "MVP'da 1 order = 1 invoice soddalashtirilgan".
   */
  async deliver(id: string, user: AuthenticatedUser, dto?: DeliverOrderDto) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);

    // 'orders.deliver' says "may close out a delivery", not "may close out
    // anyone's delivery" — a courier-only session is held to the orders
    // actually assigned to it. Warehouse/director/owner deliver any order.
    if (isCourierOnly(user) && order.courierId !== user.id) {
      throw new OrderNotAssignedToCourierException();
    }

    if (order.status !== OrderStatus.CONFIRMED && order.status !== OrderStatus.SHIPPED) {
      throw new InvalidOrderTransitionException(order.status, OrderStatus.DELIVERED);
    }
    if (order.status === OrderStatus.CONFIRMED && order.courierId !== null) {
      throw new OrderHandoverRequiredException();
    }

    // 1 order = 1 SALE invoice (DB: partial unique "Invoice_sale_orderId_key").
    // Race-safe: the order row is held FOR UPDATE, so delivers serialise here.
    const existingInvoice = await tx.invoice.findFirst({
      where: { orderId: order.id, kind: 'SALE' },
      select: { id: true },
    });
    if (existingInvoice) throw new OrderAlreadyInvoicedException(order.id);

    // F2.4: the courier Mini App path is full delivery only.
    if (dto?.lines && isCourierOnly(user)) throw new PartialDeliveryNotAllowedException();

    // Validated in full before any lock beyond the order row or any write.
    const plan = resolveDeliveryPlan(order.lines, dto?.lines);

    // Lock the customer before any stock/invoice write and re-check deletedAt:
    // a concurrent CustomersService.remove() either commits first (we refuse
    // with CustomerNotFound) or waits for us and then sees the new invoice in
    // the ledger (balance ≠ 0 → refused). Order SalesOrder → Customer →
    // StockLevel → DocCounter(INV) → Invoice; see CustomersService.lockForUpdate().
    await this.customers.lockActiveOrThrow(tx, order.customerId);

    // StockLevel locks in productId order (plan is sorted) so two deliveries /
    // confirms sharing products can't deadlock. Issue the delivered part, then
    // release the undelivered remainder of the reservation (F2.4 decision: the
    // order still goes to DELIVERED, 1 order = 1 invoice, §6.6).
    for (const { line, deliveredQty, releasedQty } of plan) {
      const move = {
        companyId: user.companyId,
        productId: line.productId,
        warehouseId: order.warehouseId,
        refType: 'SalesOrder',
        refId: order.id,
      };
      if (deliveredQty.greaterThan(0)) await this.stock.issue(tx, { ...move, qty: deliveredQty });
      if (releasedQty.greaterThan(0)) await this.stock.release(tx, { ...move, qty: releasedQty });
    }

    for (const { line, deliveredQty } of plan) {
      try {
        await tx.salesOrderLine.update({ where: { id: line.id }, data: { deliveredQty } });
      } catch (err) {
        // Backstop for SalesOrderLine_deliveredQty_range_check (23514); the
        // plan validation above should make it unreachable.
        if (isDeliveredQtyCheckViolation(err)) {
          throw new OverDeliveryException(line.id, line.qty.toString(), deliveredQty.toString());
        }
        throw err;
      }
    }

    // Invoice only from what physically left the warehouse; 0-qty lines are
    // omitted. deliveredLineTotal is the same rule orderTotal() applies to a
    // DELIVERED order, so order.total = invoice.total = Σ invoice lines.
    const invoiceLines = plan
      .filter((p) => p.deliveredQty.greaterThan(0))
      .map(({ line, deliveredQty }) => ({
        productId: line.productId,
        qty: deliveredQty,
        unitPrice: line.unitPrice,
        vatRate: line.vatRate,
        lineTotal: deliveredLineTotal({ ...line, deliveredQty }),
      }));
    const invoiceTotal = invoiceLines.reduce(
      (sum, l) => sum.plus(l.lineTotal),
      new Prisma.Decimal(0),
    );
    const invoiceNumber = await this.docNumbering.next(tx, user.companyId, 'INV');
    // A P2002 on "Invoice_sale_orderId_key" is a backstop only: Prisma 6
    // reports it with meta.target = null, indistinguishable from the
    // (companyId, number) unique, so it is not mapped — the explicit check
    // above is the guard; a P2002 here rolls the whole delivery back (500).
    const invoice = await tx.invoice.create({
      data: {
        companyId: user.companyId,
        number: invoiceNumber,
        customerId: order.customerId,
        orderId: order.id,
        total: invoiceTotal,
        status: 'OPEN',
        lines: { create: invoiceLines },
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
      newValue: toAuditJson({
        status: OrderStatus.DELIVERED,
        invoiceId: invoice.id,
        invoiceTotal: invoiceTotal.toString(),
        partial: plan.some((p) => p.releasedQty.greaterThan(0)),
        lines: plan.map(({ line, deliveredQty, releasedQty }) => ({
          lineId: line.id,
          productId: line.productId,
          qty: line.qty.toString(),
          deliveredQty: deliveredQty.toString(),
          releasedQty: releasedQty.toString(),
        })),
      }),
    });

    return withTotal(updated);
  }

  /** DELIVERED → CLOSED — administrative close, no further side effects in MVP. */
  async close(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);
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

  /**
   * §6.3 cancel (PO decision D): allowed from DRAFT/SUBMITTED (nothing reserved)
   * and CONFIRMED (reservation released here, exactly once). SHIPPED is with a
   * courier — it must first come back via returnToWarehouse() (→ CONFIRMED).
   * DELIVERED/CLOSED → 409. Already CANCELLED → idempotent no-op: same order
   * back, no second RELEASE, no second audit. The SalesOrder row lock
   * serializes concurrent cancels, so the loser re-reads CANCELLED and no-ops.
   */
  async cancel(id: string, dto: CancelOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);

    if (order.status === OrderStatus.CANCELLED) return withTotal(order);
    if (order.status === OrderStatus.SHIPPED) throw new OrderShippedRequiresReturnException();
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CLOSED) {
      throw new InvalidOrderTransitionException(order.status, OrderStatus.CANCELLED);
    }

    if (order.status === OrderStatus.CONFIRMED) {
      for (const line of sortByProduct(order.lines)) {
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
        cancelReason: dto.reason,
        cancelledAt: new Date(),
        cancelledBy: user.id,
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

  /**
   * Courier assignment (ADR-069/070: assigning ≠ shipping). CONFIRMED only;
   * status and reservation are untouched — no RESERVE/RELEASE/ISSUE, no
   * invoice. Same courier again → idempotent no-op (no audit); another
   * courier → reassign, audited old/new. SHIPPED → 409 (goods are already
   * with the courier: return to warehouse first); any other status → 409.
   */
  async assignCourier(id: string, dto: AssignCourierDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);

    if (order.status === OrderStatus.SHIPPED) throw new OrderAlreadyHandedOverException();
    if (order.status !== OrderStatus.CONFIRMED) throw new CourierAssignInvalidStatusException(order.status);

    const courierId = await this.resolveCourier(tx, dto.courierId);
    if (order.courierId === courierId) return withTotal(order);

    const reassign = order.courierId !== null;
    const updated = await tx.salesOrder.update({
      where: { id },
      data: { courierId },
      include: ORDER_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: reassign ? 'order.reassignCourier' : 'order.assignCourier',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson({ status: order.status, courierId: order.courierId }),
      newValue: toAuditJson({ status: order.status, courierId }),
    });

    await this.scheduleCourierAssignedNotification(tx, courierId, updated.number, user.companyId);

    return withTotal(updated);
  }

  /**
   * Physical hand-over to the assigned courier (ADR-069/070): CONFIRMED +
   * courier → SHIPPED. Pure logistics — the reservation stays, no stock
   * movement, no invoice (both happen only at DELIVERED). No courier → 409.
   * Already SHIPPED (with the same courier, if the caller named one) →
   * idempotent no-op, no second audit. `dto.courierId`, when sent, is a
   * compare-and-set guard: it must match the currently assigned courier.
   */
  async handover(id: string, dto: HandoverOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);

    if (order.status !== OrderStatus.CONFIRMED && order.status !== OrderStatus.SHIPPED) {
      throw new HandoverInvalidStatusException(order.status);
    }
    if (order.courierId === null) throw new HandoverCourierRequiredException();
    if (dto.courierId !== undefined && dto.courierId !== order.courierId) {
      throw new HandoverCourierMismatchException();
    }
    if (order.status === OrderStatus.SHIPPED) return withTotal(order);

    const updated = await tx.salesOrder.update({
      where: { id },
      data: { status: OrderStatus.SHIPPED },
      include: ORDER_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.handover',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson({ status: order.status, courierId: order.courierId }),
      newValue: toAuditJson({
        status: OrderStatus.SHIPPED,
        courierId: order.courierId,
        handedOverAt: new Date().toISOString(),
        ...(dto.note ? { note: dto.note } : {}),
      }),
    });

    return withTotal(updated);
  }

  /**
   * PO decision C: goods came back from the courier — SHIPPED → CONFIRMED and
   * the courier is detached. The reservation stays as is (SHIPPED carries only
   * RESERVE, never ISSUE), so no stock movement. Reason mandatory, audited.
   * Only from SHIPPED: any other status (incl. a repeat after a successful
   * return, absent an idempotency-key replay) → 409, never a second change.
   */
  async returnToWarehouse(id: string, dto: ReturnToWarehouseDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);

    if (order.status !== OrderStatus.SHIPPED) throw new ReturnToWarehouseInvalidStatusException(order.status);

    const updated = await tx.salesOrder.update({
      where: { id },
      data: { courierId: null, status: OrderStatus.CONFIRMED },
      include: ORDER_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.returnToWarehouse',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson({ status: order.status, courierId: order.courierId }),
      newValue: toAuditJson({ status: OrderStatus.CONFIRMED, courierId: null, reason: dto.reason }),
    });

    return withTotal(updated);
  }

  /** PO decision B: the courier picker for `orders.assignCourier` holders — no `users.read` needed, minimal fields only. */
  async listAssignableCouriers() {
    return this.tenantPrisma.client.user.findMany({
      where: { isActive: true, roles: { some: { role: { code: 'COURIER' } } } },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Hard delete — only for SUBMITTED orders (no stock reservation via
   * confirm(), no invoice via deliver() yet), so there's nothing else to
   * unwind. Anything past that must go through cancel() instead, which
   * releases the reservation and keeps the record for audit.
   */
  async remove(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const order = await this.getRawOrderForUpdate(tx, id);

    if (order.status !== OrderStatus.SUBMITTED) {
      throw new InvalidOrderTransitionException(order.status, 'DELETED');
    }

    await tx.salesOrderLine.deleteMany({ where: { orderId: id } });
    await tx.salesOrder.delete({ where: { id } });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'order.delete',
      entity: 'SalesOrder',
      entityId: id,
      oldValue: toAuditJson(order),
    });
  }

  /** ADR-059b at confirm time: reads each product's current minPrice; read-only. */
  private async assertLinesNotBelowMinPrice(
    tx: TenantClient,
    lines: { productId: string; unitPrice: Prisma.Decimal; discountPct: Prisma.Decimal }[],
  ): Promise<void> {
    const products = await tx.product.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.productId))] } }, select: { id: true, minPrice: true } });
    const minPriceById = new Map(products.map((p) => [p.id, p.minPrice]));
    for (const line of lines) {
      assertNotBelowMinPrice({ ...line, minPrice: minPriceById.get(line.productId) ?? null });
    }
  }

  /** Reserves every line of `order` (8.3) — shared by confirm() and create() (courier-known-up-front). */
  private async reserveOrderStock(
    tx: TenantClient,
    order: { id: string; warehouseId: string; lines: { productId: string; qty: Prisma.Decimal }[] },
    user: AuthenticatedUser,
  ): Promise<void> {
    // StockLevel locks always in productId order — see sortByProduct().
    for (const line of sortByProduct(order.lines)) {
      await this.stock.reserve(tx, {
        companyId: user.companyId,
        productId: line.productId,
        warehouseId: order.warehouseId,
        qty: line.qty,
        refType: 'SalesOrder',
        refId: order.id,
      });
    }
  }

  /**
   * Best-effort Telegram push to the Courier just assigned an order. A courier
   * is an ordinary `User`, so the chat id comes straight off `User.telegramId`
   * — the same field `NotificationsService.notify()` reads for agents, linked
   * by the same contact-share webhook flow. A courier who hasn't linked
   * Telegram yet simply gets nothing: the assignment itself must still succeed.
   *
   * The lookup runs here, inside the caller's transaction, but the actual send
   * is deferred to `TenantContext.afterCommit` so a Telegram outage can never
   * roll back or fail the order create/assign request.
   */
  private async scheduleCourierAssignedNotification(
    tx: TenantClient,
    courierId: string,
    orderNumber: string,
    companyId: string,
  ): Promise<void> {
    const courier = await tx.user.findUnique({ where: { id: courierId }, select: { telegramId: true } });
    if (!courier?.telegramId) return;

    const company = await tx.company.findUnique({ where: { id: companyId }, select: { name: true } });
    const telegramId = courier.telegramId;
    const companyName = company?.name ?? '';
    TenantContext.afterCommit(() =>
      this.notifications.notifyCourierOrderAssigned(telegramId, { orderNumber, companyName }),
    );
  }

  /**
   * Couriers are plain `User` rows carrying the fixed `COURIER` system role
   * (rbac-catalog.ts) — deliberately, so they reuse the agent Telegram login.
   * The role check is what stops an arbitrary user id (say, an accountant, or
   * a stale id from a since-demoted courier) being written into
   * `SalesOrder.courierId`, which the FK alone would happily accept.
   */
  private async resolveCourier(tx: TenantClient, courierId: string): Promise<string> {
    const courier = await tx.user.findFirst({
      where: { id: courierId, isActive: true, roles: { some: { role: { code: 'COURIER' } } } },
      select: { id: true },
    });
    if (!courier) throw new CourierNotFoundException();
    return courier.id;
  }

  /** `scope` narrows the lookup for self-scoped callers (agent's own orders, courier's own deliveries) so a foreign id reads as "not found" rather than leaking. */
  private async getRawOrder(tx: TenantClient, id: string, scope?: { agentId?: string; courierId?: string }) {
    const order = await tx.salesOrder.findFirst({
      where: { id, ...scope },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new SalesOrderNotFoundException();
    return order;
  }

  /**
   * Same as getRawOrder(), but first takes a row lock (`SELECT ... FOR UPDATE`)
   * on the SalesOrder so concurrent status transitions on one order serialize:
   * the loser re-reads the committed status and fails the state-machine check
   * instead of double-reserving / double-issuing / double-invoicing. Lock
   * order is always SalesOrder → StockLevel, so it can't deadlock with itself.
   */
  private async getRawOrderForUpdate(tx: TenantClient, id: string, scope?: { agentId?: string; courierId?: string }) {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "SalesOrder" WHERE "id" = ${id}::uuid FOR UPDATE
    `);
    if (locked.length === 0) throw new SalesOrderNotFoundException();
    return this.getRawOrder(tx, id, scope);
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

/** `total` follows orderTotal(): delivered amount for DELIVERED/CLOSED, ordered amount otherwise. */
function withTotal<T extends { status: OrderStatus; lines: OrderLineAmounts[] }>(order: T) {
  return { ...order, total: orderTotal(order) };
}
