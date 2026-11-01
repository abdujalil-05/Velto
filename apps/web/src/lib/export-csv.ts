export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number;
}

/**
 * 9.1 ("har ro'yxatda ... Excel eksport"): exports the currently loaded page
 * of rows as a CSV file, which Excel/Sheets open natively — client-side, so
 * it covers the visible page rather than the full dataset (full-dataset
 * exports go through a dedicated server endpoint, e.g. /reports/aging/export).
 */
export function exportToCsv<T>(filename: string, rows: T[], columns: CsvColumn<T>[]): void {
  const escape = (value: string | number): string => {
    let s = String(value);
    // OWASP CSV formula injection: neutralise text cells; plain numbers (incl. negatives) stay numeric.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = columns.map((c) => escape(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => escape(c.value(row))).join(','));
  const csv = [header, ...lines].join('\r\n');

  // Leading BOM so Excel opens UTF-8 (uz/ru text) correctly instead of mangling it.
  const BOM = String.fromCharCode(0xfeff);
  const blob = new Blob([BOM, csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** CSV numeric format: plain decimal, "." separator, no thousands/currency, "-" sign only, padded to `scale`; values with more decimals are emitted unchanged (never rounded); non-numeric input is returned as-is. */
export function csvDecimal(value: string | null | undefined, scale: number): string {
  if (value == null) return '';
  const m = /^\s*([+-]?)(\d+)(?:\.(\d*))?\s*$/.exec(value);
  if (!m) return value;
  const frac = m[3] ?? '';
  if (frac.length > scale) return value.trim();
  const int = m[2]!.replace(/^0+(?=\d)/, '');
  const digits = int + frac;
  const neg = m[1] === '-' && /[1-9]/.test(digits);
  return `${neg ? '-' : ''}${int}${scale > 0 ? `.${frac.padEnd(scale, '0')}` : ''}`;
}
