import ExcelJS from 'exceljs';
import type { Prisma } from '@velto/database';
import { companyDay } from '../field/company-day';

/** Cell value: Decimals are written as numbers in XLSX and as exact `.toFixed(2)` strings in CSV. */
export type ReportCell = string | number | Prisma.Decimal | null;

export interface ReportColumn {
  header: string;
  /** Money/decimal column: XLSX number format `#,##0.00`. */
  money?: boolean;
  width?: number;
}

export interface ReportSection {
  name: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
}

/**
 * Format-neutral export model: both XLSX and CSV are rendered from it, so a
 * report's file can never drift from the on-screen service result (TZ §7.3 /
 * §16.1 "hisobot eksporti = ekrandagi filtrlar").
 */
export interface ReportTable {
  title: string;
  /** Header rows: filters/period/asOf, generation time. */
  meta: [string, string][];
  /** Formula / rule notes shown under the meta rows. */
  notes: string[];
  sections: ReportSection[];
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv; charset=utf-8';
const NUMBER_FORMAT = '#,##0.00';

/** `YYYY-MM-DD HH:mm:ss (timeZone)` of `at` in the company timezone. */
export function formatGeneratedAt(at: Date, timeZone: string): string {
  const day = companyDay(at, timeZone);
  const hms = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at);
  return `${day.date} ${hms} (${timeZone})`;
}

/** Period meta rows from a resolved window, shown as company-timezone calendar days. */
export function periodMeta(range: { from: Date; to: Date }, timeZone: string): [string, string][] {
  return [['Davr (dan)', companyDay(range.from, timeZone).date], ['Davr (gacha)', companyDay(range.to, timeZone).date]];
}

/**
 * Spreadsheet formula-injection check (after optional leading whitespace): cells starting with
 * `=`, `@`, tab or CR, or `+`/`-` followed by something that is not a digit/phone/number
 * character, are neutralised. Numbers and phones (`+998901234567`, `-5`, `(99) 123-45-67`) stay intact.
 */
export function isFormulaLike(raw: string): boolean {
  if (/^[\t\r]/.test(raw)) return true;
  const t = raw.trimStart();
  if (/^[=@\t\r]/.test(t)) return true;
  if (/^[+-]/.test(t)) return !/^[+-][\s]*[\d(.,]/.test(t) || !/^[+-][\d\s().,-]*$/.test(t);
  return false;
}

function csvCell(cell: ReportCell): string {
  if (cell === null) return '';
  const raw = typeof cell === 'number' ? String(cell) : typeof cell === 'string' ? cell : cell.toFixed(2);
  const safe = typeof cell === 'string' && isFormulaLike(raw) ? `'${raw}` : raw;
  return /[",\r\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvLine(cells: ReportCell[]): string {
  return cells.map(csvCell).join(',');
}

/** UTF-8 with BOM (Excel-friendly), CRLF lines; sections are separated by a blank line. */
export function buildReportCsv(table: ReportTable): Buffer {
  const lines: string[] = [csvLine([table.title])];
  for (const [k, v] of table.meta) lines.push(csvLine([k, v]));
  for (const note of table.notes) lines.push(csvLine([note]));
  for (const section of table.sections) {
    lines.push('');
    if (table.sections.length > 1) lines.push(csvLine([section.name]));
    lines.push(csvLine(section.columns.map((c) => c.header)));
    for (const row of section.rows) lines.push(csvLine(row));
  }
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

/** Number of rows above a section's header row in each sheet: title + meta + notes + blank. */
export function xlsxHeaderRow(table: ReportTable): number {
  return 1 + table.meta.length + table.notes.length + 2;
}

export async function buildReportXlsx(table: ReportTable): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const section of table.sections) {
    const sheet = workbook.addWorksheet(section.name);
    sheet.columns = section.columns.map((c, i) => ({ key: String(i), width: c.width ?? 20 }));
    sheet.addRow([table.title]).font = { bold: true };
    for (const [k, v] of table.meta) sheet.addRow([k, v]);
    for (const note of table.notes) sheet.addRow([note]).font = { italic: true };
    sheet.addRow([]);
    sheet.addRow(section.columns.map((c) => c.header)).font = { bold: true };
    for (const row of section.rows) {
      sheet.addRow(row.map((cell) => (cell !== null && typeof cell === 'object' ? cell.toNumber() : cell)));
    }
    section.columns.forEach((c, i) => {
      if (c.money) sheet.getColumn(i + 1).numFmt = NUMBER_FORMAT;
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Render a ReportTable in the requested format. */
export async function renderReport(table: ReportTable, format: 'xlsx' | 'csv'): Promise<Buffer> {
  return format === 'csv' ? buildReportCsv(table) : buildReportXlsx(table);
}
