// UX-006/9.1: "Barcha summalar bir xil formatda: 1 234 567,00 so'm" — copied
// from apps/web/src/lib/format.ts, the unit suffix is translated (Common.somUnit).
export function formatMoney(amount: number | string): string {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) return '0,00';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function formatQty(amount: number | string): string {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(n);
}

const DATE_LOCALES: Record<string, string> = { uz: 'uz-Latn', ru: 'ru-RU', en: 'en-GB' };

export function formatDate(date: string | Date, locale: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(DATE_LOCALES[locale] ?? 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Localized weekday name (e.g. "Dushanba") — paired with formatDate() for "Dushanba, 06.08.2026" on the mini app's route screen. */
export function formatWeekday(date: string | Date, locale: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(DATE_LOCALES[locale] ?? 'en-GB', { weekday: 'long' }).format(d);
}

export function formatDateTime(date: string | Date, locale: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(DATE_LOCALES[locale] ?? 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** ISO weekday (Monday=1..Sunday=7) — mirrors apps/api's report-utils.ts isoWeekday, matches Route.weekday's convention (6.8: "weekday Int /* 1-7 *"/). */
export function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

/** Great-circle distance in meters — mirrors apps/api/src/modules/field/geo.ts's haversine, used here only for an immediate client-side distance readout (the server is the actual source of truth for gpsOk on visit submission). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}
