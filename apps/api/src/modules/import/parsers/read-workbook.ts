import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { IMPORT_LIMITS } from '../import.constants';
import { ImportFileTooLargeException } from '../import-exceptions';
import { assertZipWithinLimits } from './zip-guard';

export interface WorkbookRow {
  rowNumber: number; // 1-based spreadsheet row number (header is row 1)
  get(fieldKey: string): ExcelJS.CellValue;
}

export function isBlankCell(value: ExcelJS.CellValue): boolean {
  return value == null || value === '';
}

/**
 * Maps row 1 to field keys case-insensitively (so "Code"/"code"/"CODE" all
 * match) and reads every subsequent non-empty row by that key rather than
 * by fixed column position — column order in the template is a convenience,
 * not a contract the parser depends on.
 */
export type SpreadsheetFormat = 'xlsx' | 'csv';

export interface ReadWorkbookOptions {
  format?: SpreadsheetFormat;
  /** Tighter per-caller cap than IMPORT_LIMITS.maxDataRows (e.g. opening balances: 5000). */
  maxDataRows?: number;
}

/**
 * CSV cells are kept as raw strings (exceljs's default CSV mapping would turn
 * "0012" into 12 and money into floats) — callers parse numbers/dates exactly.
 * Delimiter: ';' when the header line has ';' but no ',' (RU/UZ Excel export), else ','.
 */
async function loadSheet(buffer: Buffer, format: SpreadsheetFormat): Promise<ExcelJS.Worksheet | undefined> {
  const workbook = new ExcelJS.Workbook();
  if (format === 'csv') {
    const headerLine = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf-8').split(/\r?\n/)[0] ?? '';
    const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
    return workbook.csv.read(Readable.from(buffer), {
      map: (datum: string) => (datum === '' ? null : datum),
      parserOptions: { delimiter },
    } as never);
  }
  assertZipWithinLimits(buffer);
  // exceljs's bundled types predate Node's generic Buffer<ArrayBufferLike>
  // and don't structurally match it — see export-1c-excel.test.ts for the
  // same cast with a fuller explanation.
  await workbook.xlsx.load(buffer as never);
  return workbook.worksheets[0];
}

export async function readWorkbookRows(buffer: Buffer, options: ReadWorkbookOptions = {}): Promise<WorkbookRow[]> {
  const maxDataRows = Math.min(options.maxDataRows ?? IMPORT_LIMITS.maxDataRows, IMPORT_LIMITS.maxDataRows);
  const sheet = await loadSheet(buffer, options.format ?? 'xlsx');
  if (!sheet) return [];

  if (sheet.columnCount > IMPORT_LIMITS.maxColumns) throw new ImportFileTooLargeException('too many columns');

  const columnIndexByKey = new Map<string, number>();
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (typeof cell.value === 'string' && cell.value.trim()) {
      columnIndexByKey.set(cell.value.trim().toLowerCase(), colNumber);
    }
  });

  const knownColumns = [...columnIndexByKey.values()];
  const rows: WorkbookRow[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    if (r > IMPORT_LIMITS.maxScannedRows) throw new ImportFileTooLargeException('too many rows');
    const row = sheet.getRow(r);
    const isEmptyRow = knownColumns.every((colNumber) => isBlankCell(row.getCell(colNumber).value));
    if (isEmptyRow) continue;

    if (rows.length >= maxDataRows) throw new ImportFileTooLargeException('too many data rows');
    rows.push({
      rowNumber: r,
      get(fieldKey: string) {
        const colNumber = columnIndexByKey.get(fieldKey.toLowerCase());
        return colNumber ? row.getCell(colNumber).value : undefined;
      },
    });
  }

  return rows;
}

export function asString(value: ExcelJS.CellValue): string | undefined {
  if (isBlankCell(value)) return undefined;
  // Rich-text cells (bold/colored spans) come back as { richText: [...] }
  if (typeof value === 'object' && value !== null && 'richText' in value) {
    const text = (value as { richText: { text: string }[] }).richText.map((s) => s.text).join('');
    return text.trim() || undefined;
  }
  const s = String(value).trim();
  return s || undefined;
}

/** `undefined` = cell was blank; `NaN` = cell had content but it isn't a valid number — callers must distinguish these. */
export function asNumber(value: ExcelJS.CellValue): number | undefined {
  if (isBlankCell(value)) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return n;
}
