import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsPositive, Max, Min } from 'class-validator';

/**
 * Input bounds for the numeric column families declared in
 * packages/database/prisma/schema.prisma (section 6.1): money is
 * `Decimal(18,2)`, quantities `Decimal(18,3)`, percentages `Decimal(5,2)`.
 *
 * Postgres `numeric(18,2)` holds |v| < 10^16 and `numeric(18,3)` |v| < 10^15;
 * anything larger raises SQLSTATE 22003, which used to surface as a bare 500.
 * These caps sit an order of magnitude below the column limit so no *single*
 * field can ever overflow on its own.
 *
 * A product of several capped fields (sales: qty x qtyInBaseUnit x unitPrice)
 * can still exceed the column, and no per-field cap can prevent that without
 * rejecting legitimate data. That residual case is handled centrally by the
 * 22003 mapping in AllExceptionsFilter, which answers 400 NUMERIC_OUT_OF_RANGE
 * instead of 500.
 */
export const MAX_MONEY = 1e15;
export const MAX_QUANTITY = 1e9;
export const MAX_PERCENT = 100;

/**
 * `IsNumber` must come before any comparison rule: `@Type(() => Number)` turns
 * a non-numeric body value into NaN, and `Infinity` satisfies `@IsPositive()`
 * on its own — both then reach Prisma and blow up as a 500. `allowNaN`/
 * `allowInfinity: false` is what actually closes that hole.
 */
const numericGuard = () => IsNumber({ allowNaN: false, allowInfinity: false });

/** Money field (`Decimal(18,2)`). Defaults to strictly positive; pass `allowZero` for balances/opening amounts. */
export function IsMoneyAmount(options: { allowZero?: boolean } = {}) {
  return applyDecorators(
    Type(() => Number),
    numericGuard(),
    ...(options.allowZero ? [Min(0)] : [IsPositive()]),
    Max(MAX_MONEY),
  );
}

/** Quantity field (`Decimal(18,3)`). Defaults to strictly positive; pass `allowZero` for received/partial amounts. */
export function IsQuantity(options: { allowZero?: boolean } = {}) {
  return applyDecorators(
    Type(() => Number),
    numericGuard(),
    ...(options.allowZero ? [Min(0)] : [IsPositive()]),
    Max(MAX_QUANTITY),
  );
}

/** Signed quantity (`StockMovement.qty` — positive is an inflow, negative an outflow). */
export function IsSignedQuantity() {
  return applyDecorators(Type(() => Number), numericGuard(), Min(-MAX_QUANTITY), Max(MAX_QUANTITY));
}

/** Percentage field (`Decimal(5,2)`) — VAT, discount. */
export function IsPercentage() {
  return applyDecorators(Type(() => Number), numericGuard(), Min(0), Max(MAX_PERCENT));
}
