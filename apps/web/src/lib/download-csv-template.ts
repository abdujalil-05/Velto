/** Downloads a header-only CSV (UTF-8 BOM so Excel reads it correctly) generated client-side. */
export function downloadCsvTemplate(filename: string, columns: readonly string[]): void {
  const blob = new Blob(['﻿', `${columns.join(',')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
