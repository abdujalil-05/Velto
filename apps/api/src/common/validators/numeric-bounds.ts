import { applyDecorators } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { Transform } from 'class-transformer';
import { IsNumber, IsPositive, Max, Min, ValidateBy, buildMessage } from 'class-validator';

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

/** Decimal places allowed per column family (schema.prisma section 6.1). */
export const MONEY_SCALE = 2;
export const QUANTITY_SCALE = 3;
export const PERCENT_SCALE = 2;

const scalePattern = (scale: number) => new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`);

/**
 * Coerces to Number only when the RAW value is a plain decimal with at most
 * `scale` places. Anything else (exponent form, float artefacts such as
 * 3.3333333333333335, over-scale digits, blank/garbage strings) is left
 * untouched so `HasMaxScale` / `IsNumber` reject it — input is never rounded.
 */
function strictDecimal(scale: number) {
  const pattern = scalePattern(scale);
  return Transform(({ value }) => {
    if (typeof value !== 'string' || !pattern.test(value)) return value;
    const n = Number(value);
    // A string the double cannot hold exactly (17+ significant digits) is left a string so IsNumber rejects it — never silently altered.
    return new Prisma.Decimal(value).equals(new Prisma.Decimal(n)) ? n : value;
  });
}

/** Rejects (never rounds) a value with more than `scale` decimal places or exponent notation. */
function HasMaxScale(scale: number) {
  const pattern = scalePattern(scale);
  return ValidateBy(
    {
      name: 'maxScale',
      constraints: [scale],
      validator: {
        validate: (value: unknown) => typeof value === 'number' && pattern.test(String(value)),
        defaultMessage: buildMessage(
          (each) =>
            `${each}$property: eng ko'pi bilan ${scale} ta kasr xona / не более ${scale} знаков после запятой / at most ${scale} decimal places`,
        ),
      },
    },
  );
}

/**
 * `IsNumber` must come before any comparison rule: a non-numeric body value
 * stays a string/NaN, and `Infinity` satisfies `@IsPositive()` on its own —
 * both then reach Prisma and blow up as a 500. `allowNaN`/`allowInfinity:
 * false` is what actually closes that hole.
 */
const decimalGuard = (scale: number) =>
  applyDecorators(strictDecimal(scale), IsNumber({ allowNaN: false, allowInfinity: false }), HasMaxScale(scale));

/** Money field (`Decimal(18,2)`). Defaults to strictly positive; pass `allowZero` for balances/opening amounts. */
export function IsMoneyAmount(options: { allowZero?: boolean } = {}) {
  return applyDecorators(
    decimalGuard(MONEY_SCALE),
    ...(options.allowZero ? [Min(0)] : [IsPositive()]),
    Max(MAX_MONEY),
  );
}

/** Quantity field (`Decimal(18,3)`). Defaults to strictly positive; pass `allowZero` for received/partial amounts. */
export function IsQuantity(options: { allowZero?: boolean } = {}) {
  return applyDecorators(
    decimalGuard(QUANTITY_SCALE),
    ...(options.allowZero ? [Min(0)] : [IsPositive()]),
    Max(MAX_QUANTITY),
  );
}

/** Signed quantity (`StockMovement.qty` — positive is an inflow, negative an outflow). */
export function IsSignedQuantity() {
  return applyDecorators(decimalGuard(QUANTITY_SCALE), Min(-MAX_QUANTITY), Max(MAX_QUANTITY));
}

/** Percentage field (`Decimal(5,2)`) — VAT, discount. */
export function IsPercentage() {
  return applyDecorators(decimalGuard(PERCENT_SCALE), Min(0), Max(MAX_PERCENT));
}
