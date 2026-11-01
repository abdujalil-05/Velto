import { Prisma } from '@velto/database';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * B2 (ADR-059): money in JSON responses is a Decimal string with exactly 2
 * places ("1500000" -> "1500000.00"), TZ section 16. Explicit allowlist of
 * response keys that carry Decimal(18,2) money — NOT "every Decimal": quantities
 * (18,3), packaging factors and percentages (5,2) keep Prisma's own format.
 * `avgCheck` is deliberately absent: it is a division result with more than 2
 * places, and formatting it would change its value.
 */
export const MONEY_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  'cachedBalance', 'balance', 'advance', 'minPrice', 'price', 'unitPrice', 'unitCost', 'lineTotal', 'total', 'totalAmount',
  'amount', 'paid', 'outstanding', 'openAmount', 'closeAmount', 'totalCollected', 'debtTotal', 'creditTotal',
  'expectedBalance', 'actualBalance', 'diffBalance', 'turnover', 'totalDebt', 'overdueDebt', 'collected',
  'current', 'd1to7', 'd8to30', 'd31to60', 'd60plus',
]);

/** Keys whose name is generic enough that only a real Decimal (never a string) is trusted as money. */
const DECIMAL_ONLY_KEYS: ReadonlySet<string> = new Set(['current']);

/** Opaque JSON passthrough columns (audit old/new, job error logs, sync entityKey, ...): arbitrary shapes, never rewritten. */
export const RAW_JSON_KEYS: ReadonlySet<string> = new Set([
  'oldValue', 'newValue', 'payload', 'errorLog', 'responseBody', 'entityKey', 'details', 'title', 'message',
]);

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Exactly 2dp string for a Decimal; null when that would round (> 2 places) — value is never altered. */
export function toMoneyString(value: Prisma.Decimal): string | null {
  return value.decimalPlaces() <= 2 ? value.toFixed(2) : null;
}

function formatMoneyValue(key: string, value: unknown): unknown {
  if (Prisma.Decimal.isDecimal(value)) return toMoneyString(value as Prisma.Decimal) ?? value;
  if (typeof value === 'string' && !DECIMAL_ONLY_KEYS.has(key) && PLAIN_DECIMAL.test(value)) {
    return toMoneyString(new Prisma.Decimal(value)) ?? value;
  }
  return value !== null && typeof value === 'object' ? formatMoneyFields(value) : value;
}

/** Deep copy of a response body with allowlisted money keys normalised. Streams/Buffers/Dates pass through. */
export function formatMoneyFields(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(formatMoneyFields);
  if (body === null || typeof body !== 'object' || Prisma.Decimal.isDecimal(body)) return body;
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = RAW_JSON_KEYS.has(k) ? v : MONEY_RESPONSE_KEYS.has(k) ? formatMoneyValue(k, v) : formatMoneyFields(v);
  }
  return out;
}

/** Global. Runs outside route-level interceptors, so an idempotent replay of a pre-change stored body is normalised too. */
@Injectable()
export class MoneyResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(formatMoneyFields));
  }
}
