import { sanitizeCell } from '../../../common/export/spreadsheet-safety';

/** One accounting document (sales invoice or payment) flattened for the CSV fallback. */
export interface CsvDocument {
  docType: 'SALE' | 'PAYMENT';
  /** Velto UUID of the Invoice/Payment: stable across re-exports (1C dedup key). */
  id: string;
  number: string;
  /** YYYY-MM-DD in the company timezone. */
  date: string;
  partnerCode: string;
  partnerName: string;
  total: string;
  /** Payment method; empty for sales. */
  method: string;
  lines: Array<{ sku: string; externalCode: string | null; qty: string; unitPrice: string; lineTotal: string }>;
}

export const EXPORT_1C_CSV_HEADER = ['docType', 'Ид', 'number', 'date', 'partnerCode', 'partnerName', 'sku', 'externalCode', 'qty', 'unitPrice', 'lineTotal', 'total', 'method'] as const;

function cell(value: string): string {
  const safe = String(sanitizeCell(value));
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Flat row-level CSV (TZ §7.3 fallback): UTF-8 BOM, CRLF, ',' separator. Sales emit one row per line; payments one row. */
export function buildExport1cCsv(documents: CsvDocument[]): Buffer {
  const rows: string[][] = [[...EXPORT_1C_CSV_HEADER]];
  for (const d of documents) {
    const head = [d.docType, d.id, d.number, d.date, d.partnerCode, d.partnerName];
    if (d.lines.length === 0) {
      rows.push([...head, '', '', '', '', '', d.total, d.method]);
    } else {
      for (const l of d.lines) rows.push([...head, l.sku, l.externalCode ?? '', l.qty, l.unitPrice, l.lineTotal, d.total, d.method]);
    }
  }
  return Buffer.from('﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n', 'utf-8');
}
