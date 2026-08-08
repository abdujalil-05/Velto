import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildExport1cWorkbook } from './export-1c-excel';

describe('buildExport1cWorkbook', () => {
  it('produces a 3-sheet workbook (kontragentlar/sotish/tolovlar) that round-trips through ExcelJS', async () => {
    const buffer = await buildExport1cWorkbook({
      customers: [{ id: 'c1', code: 'C-1', name: 'Test Customer', phone: '+998900000000' }],
      salesDocuments: [{ number: 'INV-1', date: new Date('2026-08-01'), customerName: 'Test Customer', total: '150000' }],
      payments: [{ number: 'PAY-1', date: new Date('2026-08-01'), customerName: 'Test Customer', amount: '150000', method: 'CASH' }],
    });

    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled types predate Node's generic Buffer<ArrayBufferLike>
    // and don't structurally match it — a real cross-package typing
    // friction, not a runtime issue (this is exactly the Buffer our own
    // buildExport1cWorkbook() returns).
    await workbook.xlsx.load(buffer as never);

    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toEqual(['Kontragentlar', 'Sotish hujjatlari', "To'lovlar"]);

    const customersSheet = workbook.getWorksheet('Kontragentlar')!;
    expect(customersSheet.getRow(1).values).toEqual([undefined, 'Kod', 'Nomi', 'Telefon']);
    expect(customersSheet.getRow(2).values).toEqual([undefined, 'C-1', 'Test Customer', '+998900000000']);

    // Column *keys* (as used above via .values on row 1/2) are an ExcelJS
    // runtime-only concept, not part of the xlsx file format — after a real
    // serialize+reload round-trip they're gone, so cells here must be read
    // back by their 1-based position instead of getCell('total') etc.
    const salesSheet = workbook.getWorksheet('Sotish hujjatlari')!;
    expect(salesSheet.getRow(2).getCell(1).value).toBe('INV-1'); // Raqam
    expect(salesSheet.getRow(2).getCell(4).value).toBe('150000'); // Summa

    const paymentsSheet = workbook.getWorksheet("To'lovlar")!;
    expect(paymentsSheet.getRow(2).getCell(5).value).toBe('CASH'); // Usul
  });

  it('renders empty (header-only) sheets when there is nothing for the period', async () => {
    const buffer = await buildExport1cWorkbook({ customers: [], salesDocuments: [], payments: [] });
    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled types predate Node's generic Buffer<ArrayBufferLike>
    // and don't structurally match it — a real cross-package typing
    // friction, not a runtime issue (this is exactly the Buffer our own
    // buildExport1cWorkbook() returns).
    await workbook.xlsx.load(buffer as never);

    expect(workbook.getWorksheet('Kontragentlar')!.rowCount).toBe(1); // header row only
  });
});
