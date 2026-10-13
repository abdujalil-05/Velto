/**
 * Company-timezone calendar day helpers (TZ §7.1: timestamps UTC, day
 * boundaries by Company.timezone). Server-local setHours() is wrong on any
 * host not running in the company's zone.
 */
export interface CompanyDay {
  /** YYYY-MM-DD in the company timezone. */
  date: string;
  /** ISO weekday in the company timezone, Monday=1 ... Sunday=7. */
  isoWeekday: number;
  /** UTC instant of local 00:00:00.000 (inclusive). */
  start: Date;
  /** UTC instant of the next local midnight (exclusive). */
  end: Date;
  /** `date` as a UTC-midnight Date, the shape a `@db.Date` column expects. */
  dbDate: Date;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function parts(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) map[p.type] = p.value;
  return map;
}

/** Offset (ms) of `timeZone` from UTC at the instant `at`. */
function offsetMs(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight for the local date `y-m-d` in `timeZone`. */
function localMidnightUtc(y: number, m: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let result = guess - offsetMs(new Date(guess), timeZone);
  result = guess - offsetMs(new Date(result), timeZone); // re-check across a DST edge
  return new Date(result);
}

export function companyDay(at: Date, timeZone: string): CompanyDay {
  const p = parts(at, timeZone);
  const y = +p.year!;
  const m = +p.month!;
  const d = +p.day!;
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    isoWeekday: WEEKDAYS[p.weekday!]!,
    start: localMidnightUtc(y, m, d, timeZone),
    end: localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
    dbDate: new Date(Date.UTC(y, m - 1, d)),
  };
}
