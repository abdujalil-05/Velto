import { Prisma } from '@velto/database';

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
