import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { TenantClient } from '@velto/database';
import { sanitizeCell } from '../../common/export/spreadsheet-safety';
import { COMPANY_EXPORT_PAGE_SIZE } from './company-export.constants';
import { COMPANY_EXPORT_SHEETS, type Cell } from './company-export-sheets';

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

/**
 * Streams all sheets to a temp XLSX file (ExcelJS stream writer; memory is bounded by one page), then hashes
 * it. `onSheetDone` is a liveness hook (the stale-PROCESSING sweep must not kill a long but healthy export).
 */
export async function writeCompanyWorkbook(tx: TenantClient, onSheetDone: (sheet: string) => Promise<void>): Promise<WrittenWorkbook> {
  const dir = await mkdtemp(join(tmpdir(), 'velto-company-export-'));
  const filePath = join(dir, 'export.xlsx');
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: false, useSharedStrings: false });
    let recordCount = 0;
    for (const def of COMPANY_EXPORT_SHEETS) {
      const ws = workbook.addWorksheet(def.name);
      ws.addRow(def.headers).commit();
      for (let after: unknown; ; ) {
        const { rows, next } = await def.page(tx, COMPANY_EXPORT_PAGE_SIZE, after);
        for (const row of rows) ws.addRow(row.map(toCell)).commit();
        recordCount += rows.length;
        if (next === undefined) break;
        after = next;
      }
      ws.commit();
      await onSheetDone(def.name);
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
