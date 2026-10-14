import { Logger } from '@nestjs/common';
import { OrderStatus, Prisma, type TenantClient } from '@velto/database';
import { companyDay, type CompanyDay } from '../field/company-day';
import { ORDER_LINE_AMOUNTS_SELECT } from '../sales/line-total';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  start: Date;
  end: Date;
}

/** Fallback when Company.timezone is unreadable; the schema default. */
export const DEFAULT_TIME_ZONE = 'Asia/Tashkent';

/** True when `timeZone` is an IANA zone the runtime's Intl accepts. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const tzLogger = new Logger('companyTimeZone');

/** Company.timezone of the current tenant (TZ §7.1); a legacy invalid value falls back to Asia/Tashkent with a warning. */
export async function companyTimeZone(tx: TenantClient): Promise<string> {
  const company = await tx.company.findFirst({ select: { timezone: true } });
  const stored = company?.timezone;
  if (!stored) return DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(stored)) {
    tzLogger.warn(`Invalid stored company timezone "${stored}", falling back to ${DEFAULT_TIME_ZONE}`);
    return DEFAULT_TIME_ZONE;
  }
  return stored;
}

/** UTC instant of 00:00:00.000 of the company-timezone day containing `date`. */
export function startOfDay(date: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  return companyDay(date, timeZone).start;
}

/** UTC instant of 23:59:59.999 of the company-timezone day containing `date`. */
export function endOfDay(date: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  return new Date(companyDay(date, timeZone).end.getTime() - 1);
}

/** `YYYY-MM-DD` of the company-timezone calendar day — the key day buckets and axes share. */
export function localDateString(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return companyDay(date, timeZone).date;
}

/** ISO 8601 in the company timezone: Monday=1 ... Sunday=7 — matches Route.weekday (6.8: "1-7"). */
export function isoWeekday(date: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  return companyDay(date, timeZone).isoWeekday;
}

/** Company-timezone day for a `YYYY-MM-DD` string (exact), or for the day containing a full ISO instant. */
export function companyDayOf(input: string, timeZone: string = DEFAULT_TIME_ZONE): CompanyDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return companyDay(new Date(input), timeZone);
  let probe = new Date(`${input}T12:00:00Z`);
  let day = companyDay(probe, timeZone);
  for (let i = 0; i < 2 && day.date !== input; i += 1) {
    const diff = Math.round((Date.parse(`${input}T00:00:00Z`) - Date.parse(`${day.date}T00:00:00Z`)) / DAY_MS);
    probe = new Date(probe.getTime() + diff * DAY_MS);
    day = companyDay(probe, timeZone);
  }
  return day;
}

/** Every company-timezone calendar day touched by [start, end], in order (DST-safe, unlike +24h stepping). */
export function eachCompanyDay(start: Date, end: Date, timeZone: string = DEFAULT_TIME_ZONE): CompanyDay[] {
  const days: CompanyDay[] = [];
  let day = companyDay(start, timeZone);
  while (day.start.getTime() <= end.getTime()) {
    days.push(day);
    day = companyDay(day.end, timeZone);
  }
  return days;
}

/** Inclusive [start, end] window in the company timezone. `to` extends to its end-of-day. Defaults to the last `defaultDays` days ending today. */
export function resolveDateRange(from?: string, to?: string, defaultDays = 30, timeZone: string = DEFAULT_TIME_ZONE): DateRange {
  const endDay = to ? companyDayOf(to, timeZone) : companyDay(new Date(), timeZone);
  const end = new Date(endDay.end.getTime() - 1);
  const start = from
    ? companyDayOf(from, timeZone).start
    : companyDay(new Date(endDay.start.getTime() - (defaultDays - 1) * DAY_MS + 12 * 3_600_000), timeZone).start;
  return { start, end };
}

/** One decimal place; null when there's no meaningful base to grow from (previous = 0 but current isn't). */
export function pctChange(current: Prisma.Decimal | number, previous: Prisma.Decimal | number): number | null {
  const c = typeof current === 'number' ? current : current.toNumber();
  const p = typeof previous === 'number' ? previous : previous.toNumber();
  if (p === 0) return c === 0 ? 0 : null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

/**
 * 3.2/9.3: an order that reached at least SUBMITTED counts toward every sales
 * figure in this module — DRAFT (not yet sent) and CANCELLED are excluded.
 */
export const COUNTED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.SUBMITTED,
  OrderStatus.CONFIRMED,
  OrderStatus.DELIVERED,
  OrderStatus.CLOSED,
];

/**
 * Prisma `select` every sales figure needs: status + line snapshot, so
 * DELIVERED/CLOSED orders count what was delivered (= invoice total) and the
 * rest count what was ordered — one rule, shared with SalesService (§6.6/F2.4).
 */
export const ORDER_AMOUNT_SELECT = {
  status: true,
  lines: { select: ORDER_LINE_AMOUNTS_SELECT },
} as const satisfies Prisma.SalesOrderSelect;

export { orderTotal, effectiveLineTotal } from '../sales/line-total';
