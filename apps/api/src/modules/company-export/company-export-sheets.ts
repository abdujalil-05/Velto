import type { TenantClient } from '@velto/database';

type Cell = string | number | boolean | Date | bigint | { toString(): string } | null | undefined;

export interface SheetDef {
  name: string;
  headers: string[];
  /** One cursor page (rows already mapped). `next` is undefined on the last page. */
  page(tx: TenantClient, take: number, after: unknown): Promise<{ rows: Cell[][]; next: unknown }>;
}

const idAfter = (after: unknown) => (after ? { cursor: { id: after as string }, skip: 1 } : {});

function sheet<T extends { id: string }>(name: string, headers: string[], fetch: (tx: TenantClient, args: { take: number; orderBy: { id: 'asc' }; cursor?: { id: string }; skip?: number }) => Promise<T[]>, map: (r: T) => Cell[]): SheetDef {
  return {
    name,
    headers,
    async page(tx, take, after) {
      const items = await fetch(tx, { take, orderBy: { id: 'asc' }, ...idAfter(after) });
      return { rows: items.map(map), next: items.length === take ? items[items.length - 1]!.id : undefined };
    },
  };
}

/**
 * ADR-045 sheet catalog. Deliberately explicit `select`s (never `include`/whole rows) so a column added to
 * the schema later is NOT exported by accident. Users: name/phone/email/roles/active only — never password
 * hashes, tokens, telegram ids or initData.
 */
export const COMPANY_EXPORT_SHEETS: SheetDef[] = [
  sheet('customers', ['id', 'code', 'name', 'phone', 'contactPerson', 'priceListId', 'paymentTermDays', 'isBlocked', 'blockReason', 'balance', 'isActive', 'deletedAt', 'createdAt'],
    (tx, a) => tx.customer.findMany({ ...a, select: { id: true, code: true, name: true, phone: true, contactPerson: true, priceListId: true, paymentTermDays: true, isBlocked: true, blockReason: true, cachedBalance: true, isActive: true, deletedAt: true, createdAt: true } }),
    (r) => [r.id, r.code, r.name, r.phone, r.contactPerson, r.priceListId, r.paymentTermDays, r.isBlocked, r.blockReason, r.cachedBalance, r.isActive, r.deletedAt, r.createdAt]),
  sheet('outlets', ['id', 'customerId', 'name', 'type', 'address', 'latitude', 'longitude', 'isActive', 'deletedAt', 'createdAt'],
    (tx, a) => tx.outlet.findMany({ ...a, select: { id: true, customerId: true, name: true, type: true, address: true, latitude: true, longitude: true, isActive: true, deletedAt: true, createdAt: true } }),
    (r) => [r.id, r.customerId, r.name, r.type, r.address, r.latitude, r.longitude, r.isActive, r.deletedAt, r.createdAt]),
  sheet('products', ['id', 'sku', 'barcode', 'name', 'brand', 'baseUnit', 'vatRate', 'minPrice', 'externalCode', 'categoryId', 'isActive', 'deletedAt', 'createdAt'],
    (tx, a) => tx.product.findMany({ ...a, select: { id: true, sku: true, barcode: true, name: true, brand: true, baseUnit: true, vatRate: true, minPrice: true, externalCode: true, categoryId: true, isActive: true, deletedAt: true, createdAt: true } }),
    (r) => [r.id, r.sku, r.barcode, r.name, r.brand, r.baseUnit, r.vatRate, r.minPrice, r.externalCode, r.categoryId, r.isActive, r.deletedAt, r.createdAt]),
  sheet('price_lists', ['id', 'name', 'isDefault', 'createdAt'],
    (tx, a) => tx.priceList.findMany({ ...a, select: { id: true, name: true, isDefault: true, createdAt: true } }),
    (r) => [r.id, r.name, r.isDefault, r.createdAt]),
  sheet('price_list_items', ['id', 'priceListId', 'productId', 'price'],
    (tx, a) => tx.priceListItem.findMany({ ...a, select: { id: true, priceListId: true, productId: true, price: true } }),
    (r) => [r.id, r.priceListId, r.productId, r.price]),
  {
    name: 'stock_levels',
    headers: ['productId', 'warehouseId', 'onHand', 'reserved'],
    async page(tx, take, after) {
      const cur = after as { productId: string; warehouseId: string } | undefined;
      const items = await tx.stockLevel.findMany({
        take,
        orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }],
        ...(cur ? { cursor: { productId_warehouseId: cur }, skip: 1 } : {}),
        select: { productId: true, warehouseId: true, onHand: true, reserved: true },
      });
      const last = items[items.length - 1];
      return { rows: items.map((r) => [r.productId, r.warehouseId, r.onHand, r.reserved]), next: items.length === take && last ? { productId: last.productId, warehouseId: last.warehouseId } : undefined };
    },
  },
  sheet('orders', ['id', 'number', 'customerId', 'outletId', 'agentId', 'courierId', 'warehouseId', 'status', 'note', 'cancelReason', 'cancelledAt', 'createdAt'],
    (tx, a) => tx.salesOrder.findMany({ ...a, select: { id: true, number: true, customerId: true, outletId: true, agentId: true, courierId: true, warehouseId: true, status: true, note: true, cancelReason: true, cancelledAt: true, createdAt: true } }),
    (r) => [r.id, r.number, r.customerId, r.outletId, r.agentId, r.courierId, r.warehouseId, r.status, r.note, r.cancelReason, r.cancelledAt, r.createdAt]),
  sheet('order_lines', ['id', 'orderId', 'productId', 'packagingId', 'qty', 'unitPrice', 'discountPct', 'vatRate', 'lineTotal', 'deliveredQty'],
    (tx, a) => tx.salesOrderLine.findMany({ ...a, select: { id: true, orderId: true, productId: true, packagingId: true, qty: true, unitPrice: true, discountPct: true, vatRate: true, lineTotal: true, deliveredQty: true } }),
    (r) => [r.id, r.orderId, r.productId, r.packagingId, r.qty, r.unitPrice, r.discountPct, r.vatRate, r.lineTotal, r.deliveredQty]),
  sheet('invoices', ['id', 'number', 'customerId', 'orderId', 'total', 'status', 'kind', 'openingBatchId', 'externalDocRef', 'createdAt'],
    (tx, a) => tx.invoice.findMany({ ...a, select: { id: true, number: true, customerId: true, orderId: true, total: true, status: true, kind: true, openingBatchId: true, externalDocRef: true, createdAt: true } }),
    (r) => [r.id, r.number, r.customerId, r.orderId, r.total, r.status, r.kind, r.openingBatchId, r.externalDocRef, r.createdAt]),
  sheet('invoice_lines', ['id', 'invoiceId', 'productId', 'qty', 'unitPrice', 'vatRate', 'lineTotal'],
    (tx, a) => tx.invoiceLine.findMany({ ...a, select: { id: true, invoiceId: true, productId: true, qty: true, unitPrice: true, vatRate: true, lineTotal: true } }),
    (r) => [r.id, r.invoiceId, r.productId, r.qty, r.unitPrice, r.vatRate, r.lineTotal]),
  sheet('payments', ['id', 'number', 'customerId', 'amount', 'method', 'status', 'source', 'openingBatchId', 'collectedBy', 'handoverActorId', 'handoverAt', 'handoverRejectReason', 'createdAt'],
    (tx, a) => tx.payment.findMany({ ...a, select: { id: true, number: true, customerId: true, amount: true, method: true, status: true, source: true, openingBatchId: true, collectedBy: true, handoverActorId: true, handoverAt: true, handoverRejectReason: true, createdAt: true } }),
    (r) => [r.id, r.number, r.customerId, r.amount, r.method, r.status, r.source, r.openingBatchId, r.collectedBy, r.handoverActorId, r.handoverAt, r.handoverRejectReason, r.createdAt]),
  sheet('payment_allocations', ['id', 'paymentId', 'invoiceId', 'amount', 'createdAt'],
    (tx, a) => tx.paymentAllocation.findMany({ ...a, select: { id: true, paymentId: true, invoiceId: true, amount: true, createdAt: true } }),
    (r) => [r.id, r.paymentId, r.invoiceId, r.amount, r.createdAt]),
  sheet('users', ['id', 'firstName', 'lastName', 'phone', 'email', 'roles', 'isActive', 'createdAt'],
    (tx, a) => tx.user.findMany({ ...a, select: { id: true, firstName: true, lastName: true, phone: true, email: true, isActive: true, createdAt: true, roles: { select: { role: { select: { code: true } } } } } }),
    (r) => [r.id, r.firstName, r.lastName, r.phone, r.email, r.roles.map((x) => x.role.code).sort().join(', '), r.isActive, r.createdAt]),
  sheet('opening_batches', ['id', 'kind', 'asOfDate', 'source', 'status', 'rowCount', 'debtTotal', 'creditTotal', 'qtyTotal', 'createdBy', 'postedBy', 'postedAt', 'voidedBy', 'voidedAt', 'voidReason', 'createdAt'],
    (tx, a) => tx.openingBalanceBatch.findMany({ ...a, select: { id: true, kind: true, asOfDate: true, source: true, status: true, rowCount: true, debtTotal: true, creditTotal: true, qtyTotal: true, createdBy: true, postedBy: true, postedAt: true, voidedBy: true, voidedAt: true, voidReason: true, createdAt: true } }),
    (r) => [r.id, r.kind, r.asOfDate, r.source, r.status, r.rowCount, r.debtTotal, r.creditTotal, r.qtyTotal, r.createdBy, r.postedBy, r.postedAt, r.voidedBy, r.voidedAt, r.voidReason, r.createdAt]),
];

export type { Cell };
