import { OrderStatus, Prisma } from '@velto/database';

type DecimalInput = Prisma.Decimal | string | number;

/**
 * Server-side order line total (§6.6): qty × price × (1 − discount%) × (1 + VAT%).
 * Pure Decimal arithmetic, no explicit rounding here — the value is rounded once,
 * on write, by the `Decimal(18,2)` column (unchanged from the previous inline formula).
 */
export function calcLineTotal(
  qty: DecimalInput,
  price: DecimalInput,
  discountPct: DecimalInput,
  vatRate: DecimalInput,
): Prisma.Decimal {
  const one = new Prisma.Decimal(1);
  return new Prisma.Decimal(qty)
    .times(price)
    .times(one.minus(new Prisma.Decimal(discountPct).dividedBy(100)))
    .times(one.plus(new Prisma.Decimal(vatRate).dividedBy(100)));
}

/**
 * A line total as it is stored: rounded once, half-up to 2dp — the value the
 * `Decimal(18,2)` column holds for {@link calcLineTotal}. Only for figures that
 * must match a stored total (e.g. PRICE_CHANGED details); never changes what is persisted.
 */
export function roundLineTotal(lineTotal: Prisma.Decimal): Prisma.Decimal {
  return lineTotal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** The snapshot fields an order line needs to price what was actually delivered. */
export interface OrderLineAmounts {
  qty: Prisma.Decimal;
  deliveredQty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPct: Prisma.Decimal;
  vatRate: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/** Prisma `select` for {@link OrderLineAmounts} — reuse wherever order amounts are summed. */
export const ORDER_LINE_AMOUNTS_SELECT = {
  qty: true,
  deliveredQty: true,
  unitPrice: true,
  discountPct: true,
  vatRate: true,
  lineTotal: true,
} as const satisfies Prisma.SalesOrderLineSelect;

/**
 * Amount of a line for the quantity that physically left the warehouse (F2.4).
 * A fully delivered line keeps its snapshot `lineTotal` exactly; a partial one
 * is recomputed from the same snapshot and rounded once, half-up to 2dp — the
 * same value the invoice line gets, so Σ over an order equals `invoice.total`.
 */
export function deliveredLineTotal(line: OrderLineAmounts): Prisma.Decimal {
  if (line.deliveredQty.equals(line.qty)) return line.lineTotal;
  return roundLineTotal(calcLineTotal(line.deliveredQty, line.unitPrice, line.discountPct, line.vatRate));
}

/** Statuses after goods issue: their amounts are what was delivered, not what was ordered. */
export const DELIVERY_PRICED_STATUSES: readonly OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.CLOSED];

/** One line's amount under the order's status: delivered amount for DELIVERED/CLOSED, ordered snapshot otherwise. */
export function effectiveLineTotal(status: OrderStatus, line: OrderLineAmounts): Prisma.Decimal {
  return DELIVERY_PRICED_STATUSES.includes(status) ? deliveredLineTotal(line) : line.lineTotal;
}

/**
 * The order amount (§6.6) as one rule for the whole API: DELIVERED/CLOSED →
 * Σ delivered line amounts (= invoice total); any other status → Σ ordered
 * snapshot `lineTotal`.
 */
export function orderTotal(order: { status: OrderStatus; lines: readonly OrderLineAmounts[] }): Prisma.Decimal {
  return order.lines.reduce((sum, l) => sum.plus(effectiveLineTotal(order.status, l)), new Prisma.Decimal(0));
}
