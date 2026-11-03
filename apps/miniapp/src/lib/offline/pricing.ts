import type { SyncPriceItem, SyncProduct, SyncPackaging } from '@/lib/api/sync';

interface Dec {
  int: bigint;
  scale: number;
}

/** Parses a number or decimal string into an exact scaled BigInt (no float arithmetic). */
function toDec(v: number | string): Dec {
  let str = typeof v === 'number' ? (Number.isFinite(v) ? (/e/i.test(String(v)) ? v.toFixed(20) : String(v)) : '0') : v.trim();
  if (!/^[+-]?\d*\.?\d*$/.test(str) || str === '' || str === '.') str = '0';
  const neg = str.startsWith('-');
  const [i = '', f = ''] = str.replace(/^[+-]/, '').split('.');
  const frac = f.replace(/0+$/, '');
  const int = BigInt((i || '0') + frac);
  return { int: neg ? -int : int, scale: frac.length };
}

function mul(a: Dec, b: Dec): Dec {
  return { int: a.int * b.int, scale: a.scale + b.scale };
}

/** 100 ± pct, scaled by 100 (i.e. the factor (1 ± pct/100) exactly). */
function factor(pct: Dec, sign: 1n | -1n): Dec {
  return { int: 100n * 10n ** BigInt(pct.scale) + sign * pct.int, scale: pct.scale + 2 };
}

/** Rounds HALF_UP (away from zero on ties, like Prisma.Decimal.ROUND_HALF_UP) to integer cents. */
function toCents(d: Dec): bigint {
  const neg = d.int < 0n;
  const abs = neg ? -d.int : d.int;
  let cents: bigint;
  if (d.scale <= 2) {
    cents = abs * 10n ** BigInt(2 - d.scale);
  } else {
    const div = 10n ** BigInt(d.scale - 2);
    cents = abs / div;
    if ((abs % div) * 2n >= div) cents += 1n;
  }
  return neg ? -cents : cents;
}

function lineCents(params: {
  qty: number | string;
  packagingQtyInBaseUnit: number | string;
  price: number | string;
  discountPct: number | string;
  vatRate: number | string;
}): bigint {
  let d = mul(toDec(params.qty), toDec(params.packagingQtyInBaseUnit));
  d = mul(d, toDec(params.price));
  d = mul(d, factor(toDec(params.discountPct), -1n));
  d = mul(d, factor(toDec(params.vatRate), 1n));
  return toCents(d);
}

function centsToNumber(c: bigint): number {
  return Number(c) / 100;
}

/** Mirrors apps/api's calcLineTotal (sales/line-total.ts, 6.6): exact qty×price×(1−d/100)×(1+v/100) in scaled BigInt, rounded HALF_UP to 2dp per line like the server's Decimal(18,2) column. Preview only; the server recomputes on submit. */
export function computeLineTotal(params: {
  qty: number | string;
  packagingQtyInBaseUnit: number | string;
  price: number | string;
  discountPct: number | string;
  vatRate: number | string;
}): number {
  return centsToNumber(lineCents(params));
}

/** 8.1: customer's own price list, falling back to the company default — matches SalesService.create()'s `customer.priceListId ?? defaultPriceListId()`. */
export function resolvePrice(
  productId: string,
  customerPriceListId: string | null,
  defaultPriceListId: string | null,
  prices: SyncPriceItem[],
): string | undefined {
  const listId = customerPriceListId ?? defaultPriceListId;
  if (!listId) return undefined;
  return prices.find((p) => p.productId === productId && p.priceListId === listId)?.price;
}

export interface EstimateOrderLine {
  productId: string;
  packagingId: string;
  qty: number;
  discountPct?: number;
}

/** Estimates an order's total from its lines alone (as queued offline, before the server confirms) — used by Home's offline "today's turnover" figure. Skips lines whose product/packaging/price can't be resolved locally rather than throwing, since a stale/incomplete local cache shouldn't crash the dashboard. */
export function estimateOrderTotal(
  lines: EstimateOrderLine[],
  customerPriceListId: string | null,
  defaultPriceListId: string | null,
  products: SyncProduct[],
  packagings: SyncPackaging[],
  prices: SyncPriceItem[],
): number {
  let totalCents = 0n;
  for (const line of lines) {
    const product = products.find((p) => p.id === line.productId);
    const packaging = packagings.find((p) => p.id === line.packagingId);
    const price = resolvePrice(line.productId, customerPriceListId, defaultPriceListId, prices);
    if (!product || !packaging || price === undefined) continue;
    totalCents += lineCents({
      qty: line.qty,
      packagingQtyInBaseUnit: packaging.qtyInBaseUnit,
      price,
      discountPct: line.discountPct ?? 0,
      vatRate: product.vatRate,
    });
  }
  // Σ of already-rounded lines, not re-rounded (matches the server's order total).
  return centsToNumber(totalCents);
}

/**
 * Order composition (F4): stamps every line with the base-unit price the agent
 * saw on screen (`resolvePrice`) as `expectedUnitPrice`, so the server can
 * answer CONFLICT/PRICE_CHANGED instead of silently re-pricing. A line whose
 * price is unknown locally (nothing was shown) is sent without it.
 */
export function withExpectedUnitPrices<L extends { productId: string }>(
  lines: L[],
  customerPriceListId: string | null,
  defaultPriceListId: string | null,
  prices: SyncPriceItem[],
): (L & { expectedUnitPrice?: string })[] {
  return lines.map((l) => {
    const price = resolvePrice(l.productId, customerPriceListId, defaultPriceListId, prices);
    return price === undefined ? l : { ...l, expectedUnitPrice: price };
  });
}

// ---- ADR-059: exact decimal input checks (client-side UX mirror; the server stays the authority) ----

/** Max decimals: money 2 (tiyin), quantity 3. */
export const MONEY_SCALE = 2;
export const QTY_SCALE = 3;

function decToString(int: bigint, scale: number): string {
  const neg = int < 0n;
  let digits = (neg ? -int : int).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    const frac = digits.slice(-scale).replace(/0+$/, '');
    digits = digits.slice(0, -scale) + (frac ? `.${frac}` : '');
  }
  return (neg ? '-' : '') + digits;
}

/** Strict plain-decimal parse (`,` accepted as separator); null for anything else (exponent, junk, empty). Never goes through Number. */
export function parseDecimalString(input: string): string | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  return s.startsWith('.') ? `0${s}` : s;
}

/** Number of significant decimals (trailing zeros ignored). */
export function decimalScale(v: number | string): number {
  return toDec(v).scale;
}

export type DecimalCheck = 'ok' | 'invalid' | 'scale';

/** Plain decimal string with at most `maxScale` significant decimals. */
export function checkDecimal(input: string, maxScale: number): DecimalCheck {
  const s = parseDecimalString(input);
  if (s === null) return 'invalid';
  return decimalScale(s) > maxScale ? 'scale' : 'ok';
}

/** Order-line rule: qty ≤3dp AND qty × packagingQtyInBaseUnit ≤3dp. */
export function checkQty(qty: number | string, packagingQtyInBaseUnit: number | string): 'ok' | 'qtyScale' | 'baseScale' {
  if (decimalScale(qty) > QTY_SCALE) return 'qtyScale';
  const base = mul(toDec(qty), toDec(packagingQtyInBaseUnit));
  return toDec(decToString(base.int, base.scale)).scale > QTY_SCALE ? 'baseScale' : 'ok';
}

/** baseQty ÷ factor as an exact decimal string with ≤3dp, or null when not exact (no rounding, ever). */
export function divideExact(baseQty: number | string, packagingQtyInBaseUnit: number | string): string | null {
  const a = toDec(baseQty);
  const b = toDec(packagingQtyInBaseUnit);
  if (b.int <= 0n) return null;
  const num = a.int * 10n ** BigInt(b.scale + QTY_SCALE);
  const den = b.int * 10n ** BigInt(a.scale);
  if (num % den !== 0n) return null;
  return decToString(num / den, QTY_SCALE);
}

export type RepeatLineResult = { packagingId: string; qty: string } | null;

/** Repeat-order line: exact qty in the original packaging, else the product's base packaging (factor 1), else null = needs manual qty. */
export function repeatLineQty(
  baseQty: number | string,
  packagingId: string,
  productPackagings: { id: string; qtyInBaseUnit: string }[],
): RepeatLineResult {
  const pkg = productPackagings.find((p) => p.id === packagingId);
  if (pkg) {
    const q = divideExact(baseQty, pkg.qtyInBaseUnit);
    if (q !== null) return { packagingId, qty: q };
  }
  const base = productPackagings.find((p) => {
    const d = toDec(p.qtyInBaseUnit);
    return d.int === 1n && d.scale === 0;
  });
  if (base && decimalScale(baseQty) <= QTY_SCALE) {
    const d = toDec(baseQty);
    return { packagingId: base.id, qty: decToString(d.int, d.scale) };
  }
  return null;
}
