import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { TenantClient } from '@velto/database';
import { writeCompanyWorkbook, sheetNameFor } from './company-export-writer';
import { COMPANY_EXPORT_SHEETS, type SheetDef } from './company-export-sheets';

const tx = {} as TenantClient;
const fake = (name: string, total: number): SheetDef => ({
  name,
  headers: ['n'],
  async page(_tx, take, after) {
    const from = (after as number | undefined) ?? 0;
    const n = Math.min(take, total - from);
    return { rows: Array.from({ length: n }, (_, i) => [from + i]), next: from + n < total ? from + n : undefined };
  },
});

describe('company export writer', () => {
  it('splits a sheet at the row limit: orders, orders_2, ... with header repeated; no row lost', async () => {
    const w = await writeCompanyWorkbook(tx, async () => {}, { sheets: [fake('orders', 10)], maxSheetRows: 4, pageSize: 3 });
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await readFile(w.filePath)) as never);
      expect(wb.worksheets.map((s) => s.name)).toEqual(['orders', 'orders_2', 'orders_3', 'orders_4']);
      expect(wb.worksheets.map((s) => s.rowCount)).toEqual([4, 4, 4, 2]); // header + 3 data rows each; last: header + 1
      expect(w.recordCount).toBe(10);
      expect(sheetNameFor('x', 1)).toBe('x');
    } finally {
      await w.dispose();
    }
  });

  it('heartbeat fires inside one long sheet (every N pages), not only when the sheet ends', async () => {
    let calls = 0;
    const w = await writeCompanyWorkbook(tx, async () => { calls++; }, { sheets: [fake('big', 100)], pageSize: 2, heartbeatEveryPages: 5 });
    await w.dispose();
    expect(calls).toBeGreaterThanOrEqual(10); // 50 pages / 5 + final
  });

  it('sheet catalog: unique names <= 31 chars, no credential/token columns', () => {
    const names = COMPANY_EXPORT_SHEETS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.length <= 25)).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['stock_movements', 'payment_reversals', 'warehouses', 'cash_sessions']));
    const cols = COMPANY_EXPORT_SHEETS.flatMap((s) => s.headers).join(' ');
    expect(cols).not.toMatch(/password|hash|token|initData|telegram|secret|salt/i);
  });
});
