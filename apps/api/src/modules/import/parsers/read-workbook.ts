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
export async function readWorkbookRows(buffer: Buffer): Promise<WorkbookRow[]> {
  assertZipWithinLimits(buffer);
  const workbook = new ExcelJS.Workbook();
  // exceljs's bundled types predate Node's generic Buffer<ArrayBufferLike>
  // and don't structurally match it — see export-1c-excel.test.ts for the
  // same cast with a fuller explanation.
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
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

    if (rows.length >= IMPORT_LIMITS.maxDataRows) throw new ImportFileTooLargeException('too many data rows');
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
