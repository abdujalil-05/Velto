import { describe, expect, it } from 'vitest';
import { parseCustomersWorkbook } from './customers-parser';
import { buildTestWorkbook } from './test-workbook';

const HEADERS = [
  'code',
  'name',
  'phone',
  'contactPerson',
  'paymentTermDays',
  'outletName',
  'outletAddress',
  'outletLatitude',
  'outletLongitude',
];

describe('parseCustomersWorkbook', () => {
  it('parses a fully-populated valid row', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['C-1', 'Test Customer', '+998901234567', 'Aziz', 14, 'Main Outlet', 'Tashkent', 41.3, 69.2],
    ]);
    const result = await parseCustomersWorkbook(buffer, new Set());

    expect(result.errors).toHaveLength(0);
    expect(result.validRows).toHaveLength(1);
    expect(result.validRows[0]).toMatchObject({
      rowNumber: 2,
      code: 'C-1',
      name: 'Test Customer',
      paymentTermDays: 14,
      outletName: 'Main Outlet',
      outletLatitude: 41.3,
      outletLongitude: 69.2,
    });
  });

  it('defaults the outlet name to the customer name and numeric fields to 0 when left blank', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [['C-1', 'Test Customer', '', '', '', '', '', '', '']]);
    const result = await parseCustomersWorkbook(buffer, new Set());

    expect(result.errors).toHaveLength(0);
    expect(result.validRows[0]).toMatchObject({ outletName: 'Test Customer', paymentTermDays: 0 });
  });

  it('requires code and name', async () => {
    // contactPerson is set so the row isn't entirely blank (a fully blank
    // row is deliberately skipped rather than validated — see the
    // "skips fully blank trailing rows" test below).
    const buffer = await buildTestWorkbook(HEADERS, [['', '', '', 'Someone', '', '', '', '', '']]);
    const result = await parseCustomersWorkbook(buffer, new Set());

    expect(result.validRows).toHaveLength(0);
    expect(result.errors).toEqual([{ row: 2, messages: expect.arrayContaining(['code majburiy', 'name majburiy']) }]);
  });

  it('flags a code that repeats within the file, and a code that already exists in the DB', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['C-1', 'First', '', '', '', '', '', '', ''],
      ['C-1', 'Second', '', '', '', '', '', '', ''],
      ['C-EXISTING', 'Third', '', '', '', '', '', '', ''],
    ]);
    const result = await parseCustomersWorkbook(buffer, new Set(['C-EXISTING']));

    expect(result.validRows).toHaveLength(1); // only the first "C-1" row
    expect(result.errors).toEqual([
      { row: 3, messages: ['code "C-1" faylda takrorlangan'] },
      { row: 4, messages: ['code "C-EXISTING" allaqachon mavjud'] },
    ]);
  });

  it('requires both outlet coordinates together, and rejects out-of-range values', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['C-1', 'Only Lat', '', '', '', '', '', 41.3, ''],
      ['C-2', 'Out Of Range', '', '', '', '', '', 999, 69.2],
    ]);
    const result = await parseCustomersWorkbook(buffer, new Set());

    expect(result.validRows).toHaveLength(0);
    expect(result.errors[0]!.messages).toContain('outletLatitude va outletLongitude ikkalasi ham kiritilishi kerak');
    expect(result.errors[1]!.messages.some((m) => m.includes('outletLatitude'))).toBe(true);
  });

  it('skips fully blank trailing rows instead of treating them as errors', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['C-1', 'Test Customer', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', ''],
    ]);
    const result = await parseCustomersWorkbook(buffer, new Set());

    expect(result.totalRows).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('matches headers case-insensitively', async () => {
    const buffer = await buildTestWorkbook(
      ['CODE', 'Name'],
      [['C-1', 'Test Customer']],
    );
    const result = await parseCustomersWorkbook(buffer, new Set());
    expect(result.validRows[0]).toMatchObject({ code: 'C-1', name: 'Test Customer' });
  });
});
