import { OrderStatus, Prisma } from '@velto/database';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  start: Date;
  end: Date;
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * `YYYY-MM-DD` from the *local* date parts — day buckets must be keyed the
 * same way the startOfDay()-based axis loops walk them; `toISOString()` is
 * UTC and shifts rows into the neighbouring bucket for any non-UTC server.
 */
export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** ISO 8601: Monday=1 ... Sunday=7 — matches how Route.weekday (6.8: "1-7") is validated in CreateRouteDto. */
export function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

/** Inclusive [start, end] window. `to` (if given) is extended to its end-of-day boundary. Defaults to the last `defaultDays` days ending today. */
export function resolveDateRange(from?: string, to?: string, defaultDays = 30): DateRange {
  const end = to ? endOfDay(new Date(to)) : endOfDay(new Date());
  const start = from ? startOfDay(new Date(from)) : startOfDay(new Date(end.getTime() - (defaultDays - 1) * DAY_MS));
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

export function sumLineTotals(lines: { lineTotal: Prisma.Decimal }[]): Prisma.Decimal {
  return lines.reduce((sum, l) => sum.plus(l.lineTotal), new Prisma.Decimal(0));
}
