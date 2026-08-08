// UX-006/9.1: "Barcha summalar bir xil formatda: 1 234 567,00 so'm" — the
// unit suffix is translated (Common.somUnit), only the number is formatted here.
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

/** Signed percent change for "vs yesterday" style deltas — null when there's no baseline to compare against. */
export function formatPercentChange(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
