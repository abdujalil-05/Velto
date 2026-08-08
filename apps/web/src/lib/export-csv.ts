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
    const s = String(value);
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
