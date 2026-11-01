import { Prisma } from '@velto/database';
import { OrderPriceBelowMinException, OrderQtyPrecisionException } from './sales-exceptions';

/** SalesOrderLine.qty / StockMovement.qty are Decimal(18,3). */
export const MAX_QTY_DECIMALS = 3;

/**
 * ADR-059a: rejects (never rounds) an entered qty or base qty finer than
 * 3 dp. Decimal only — `baseQty` must be the exact product, not a JS number.
 */
export function assertQtyPrecision(line: { productId: string; packagingId: string; qty: Prisma.Decimal; qtyInBaseUnit: Prisma.Decimal; baseQty: Prisma.Decimal }): void {
  if (line.qty.decimalPlaces() <= MAX_QTY_DECIMALS && line.baseQty.decimalPlaces() <= MAX_QTY_DECIMALS) return;
  throw new OrderQtyPrecisionException({
    productId: line.productId,
    packagingId: line.packagingId,
    qty: line.qty.toString(),
    qtyInBaseUnit: line.qtyInBaseUnit.toString(),
    baseQty: line.baseQty.toString(),
    maxDecimals: MAX_QTY_DECIMALS,
  });
}

/** Unrounded ex-VAT base-unit price after the line discount. */
export function effectiveUnitPrice(unitPrice: Prisma.Decimal, discountPct: Prisma.Decimal): Prisma.Decimal {
  return unitPrice.times(new Prisma.Decimal(1).minus(discountPct.dividedBy(100)));
}

/** ADR-059b: no-op when minPrice is null; otherwise effective price must be ≥ minPrice. */
export function assertNotBelowMinPrice(line: { productId: string; unitPrice: Prisma.Decimal; discountPct: Prisma.Decimal; minPrice: Prisma.Decimal | null }): void {
  if (line.minPrice === null) return;
  const effective = effectiveUnitPrice(line.unitPrice, line.discountPct);
  if (effective.greaterThanOrEqualTo(line.minPrice)) return;
  throw new OrderPriceBelowMinException({ productId: line.productId, effectivePrice: effective.toString(), minPrice: line.minPrice.toFixed(2) });
}
