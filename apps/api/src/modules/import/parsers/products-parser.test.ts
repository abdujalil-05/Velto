import { describe, expect, it } from 'vitest';
import { parseProductsWorkbook } from './products-parser';
import { buildTestWorkbook } from './test-workbook';

const HEADERS = ['sku', 'name', 'categoryName', 'brand', 'baseUnit', 'vatRate', 'minPrice', 'barcode', 'externalCode'];

describe('parseProductsWorkbook', () => {
  it('parses a fully-populated valid row', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['SKU-1', 'Coca-Cola', 'Ichimliklar', 'Coca-Cola', 'dona', 12, 4500, '4870001234567', '1C-001'],
    ]);
    const result = await parseProductsWorkbook(buffer, new Set());

    expect(result.errors).toHaveLength(0);
    expect(result.validRows[0]).toMatchObject({
      rowNumber: 2,
      sku: 'SKU-1',
      name: 'Coca-Cola',
      categoryName: 'Ichimliklar',
      baseUnit: 'dona',
      vatRate: 12,
      minPrice: 4500,
      externalCode: '1C-001',
    });
  });

  it('defaults externalCode to sku and vatRate to 12 when left blank', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [['SKU-1', 'Product', '', '', 'dona', '', '', '', '']]);
    const result = await parseProductsWorkbook(buffer, new Set());

    expect(result.errors).toHaveLength(0);
    expect(result.validRows[0]).toMatchObject({ externalCode: 'SKU-1', vatRate: 12 });
  });

  it('requires sku, name, and baseUnit', async () => {
    // brand is set so the row isn't entirely blank (a fully blank row is
    // deliberately skipped rather than validated — see the "skips fully
    // blank trailing rows" test below).
    const buffer = await buildTestWorkbook(HEADERS, [['', '', '', 'SomeBrand', '', '', '', '', '']]);
    const result = await parseProductsWorkbook(buffer, new Set());

    expect(result.validRows).toHaveLength(0);
    expect(result.errors).toEqual([
      { row: 2, messages: expect.arrayContaining(['sku majburiy', 'name majburiy', 'baseUnit majburiy']) },
    ]);
  });

  it('flags a sku that repeats within the file, and a sku that already exists in the DB', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['SKU-1', 'First', '', '', 'dona', '', '', '', ''],
      ['SKU-1', 'Second', '', '', 'dona', '', '', '', ''],
      ['SKU-EXISTING', 'Third', '', '', 'dona', '', '', '', ''],
    ]);
    const result = await parseProductsWorkbook(buffer, new Set(['SKU-EXISTING']));

    expect(result.validRows).toHaveLength(1);
    expect(result.errors).toEqual([
      { row: 3, messages: ['sku "SKU-1" faylda takrorlangan'] },
      { row: 4, messages: ['sku "SKU-EXISTING" allaqachon mavjud'] },
    ]);
  });

  it('rejects an out-of-range vatRate and a negative minPrice', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['SKU-1', 'Bad VAT', '', '', 'dona', 150, '', '', ''],
      ['SKU-2', 'Bad Price', '', '', 'dona', '', -100, '', ''],
    ]);
    const result = await parseProductsWorkbook(buffer, new Set());

    expect(result.validRows).toHaveLength(0);
    expect(result.errors[0]!.messages).toContain("vatRate 0..100 oralig'ida bo'lishi kerak");
    expect(result.errors[1]!.messages).toContain("minPrice manfiy bo'lmagan son bo'lishi kerak");
  });

  it('skips fully blank trailing rows instead of treating them as errors', async () => {
    const buffer = await buildTestWorkbook(HEADERS, [
      ['SKU-1', 'Product', '', '', 'dona', '', '', '', ''],
      ['', '', '', '', '', '', '', '', ''],
    ]);
    const result = await parseProductsWorkbook(buffer, new Set());

    expect(result.totalRows).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
