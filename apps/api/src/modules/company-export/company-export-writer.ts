import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { TenantClient } from '@velto/database';
import { sanitizeCell } from '../../common/export/spreadsheet-safety';
import { COMPANY_EXPORT_HEARTBEAT_EVERY_PAGES, COMPANY_EXPORT_PAGE_SIZE, XLSX_MAX_SHEET_ROWS } from './company-export.constants';
import { COMPANY_EXPORT_SHEETS, type Cell, type SheetDef } from './company-export-sheets';

/** Every cell passes through sanitizeCell (formula-injection defence); dates/decimals become strings. */
function toCell(v: Cell): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return sanitizeCell(typeof v === 'string' ? v : v.toString());
}

export interface WrittenWorkbook {
  filePath: string;
  fileSize: number;
  fileHash: string;
  recordCount: number;
  dispose(): Promise<void>;
}

export interface WriterOptions {
  /** Test seams; production uses the defaults. */
  sheets?: SheetDef[];
  maxSheetRows?: number;
  pageSize?: number;
  heartbeatEveryPages?: number;
}

/** Overflow naming: orders, orders_2, orders_3 ... (Excel sheet names are capped at 31 chars). */
export function sheetNameFor(base: string, part: number): string {
  return part === 1 ? base : `${base}_${part}`;
}

/**
 * Streams all sheets to a temp XLSX file (ExcelJS stream writer; memory is bounded by one page), then hashes
 * it. `onProgress` is a liveness hook (the stale-PROCESSING sweep must not kill a long but healthy export):
 * called after every sheet part and every N pages inside a sheet. A sheet reaching the Excel row limit continues
 * in `<name>_2`, `<name>_3`... with the header repeated.
 */
export async function writeCompanyWorkbook(tx: TenantClient, onProgress: (sheet: string) => Promise<void>, opts: WriterOptions = {}): Promise<WrittenWorkbook> {
  const { sheets = COMPANY_EXPORT_SHEETS, maxSheetRows = XLSX_MAX_SHEET_ROWS, pageSize = COMPANY_EXPORT_PAGE_SIZE, heartbeatEveryPages = COMPANY_EXPORT_HEARTBEAT_EVERY_PAGES } = opts;
  const dir = await mkdtemp(join(tmpdir(), 'velto-company-export-'));
  const filePath = join(dir, 'export.xlsx');
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: false, useSharedStrings: false });
    let recordCount = 0;
    for (const def of sheets) {
      let part = 1;
      let ws = workbook.addWorksheet(sheetNameFor(def.name, part));
      ws.addRow(def.headers).commit();
      let rowsInSheet = 1;
      let pages = 0;
      for (let after: unknown; ; ) {
        const { rows, next } = await def.page(tx, pageSize, after);
        for (const row of rows) {
          if (rowsInSheet >= maxSheetRows) {
            ws.commit();
            await onProgress(ws.name);
            ws = workbook.addWorksheet(sheetNameFor(def.name, ++part));
            ws.addRow(def.headers).commit();
            rowsInSheet = 1;
          }
          ws.addRow(row.map(toCell)).commit();
          rowsInSheet++;
        }
        recordCount += rows.length;
        if (++pages % heartbeatEveryPages === 0) await onProgress(ws.name);
        if (next === undefined) break;
        after = next;
      }
      ws.commit();
      await onProgress(ws.name);
    }
    await workbook.commit();

    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
    return { filePath, fileSize: (await stat(filePath)).size, fileHash: hash.digest('hex'), recordCount, dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}
