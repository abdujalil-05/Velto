import type { RowError } from '../import.constants';
import type { ParseResult } from './customers-parser';
import { asNumber, asString, readWorkbookRows } from './read-workbook';

export interface ProductImportRow {
  rowNumber: number;
  sku: string;
  name: string;
  categoryName?: string;
  brand?: string;
  baseUnit: string;
  vatRate: number;
  minPrice?: number;
  barcode?: string;
  externalCode: string;
}

/**
 * 9.2/11.4: validates against the same rules CreateProductDto enforces
 * (6.4), plus file-local and DB-existing `sku` uniqueness. `categoryName` is
 * free text here — resolving it to an existing category or creating a new
 * one is a write, so it only happens at confirm() time, not during this
 * read-only validation pass. Packaging isn't part of the flat import row at
 * all: every imported product gets one default packaging matching its
 * `baseUnit` (qty 1) on confirm — matching baseUnit/blok/quti variants can
 * be added afterwards through the regular Products screen.
 */
export async function parseProductsWorkbook(buffer: Buffer, existingSkus: Set<string>): Promise<ParseResult<ProductImportRow>> {
  const rows = await readWorkbookRows(buffer);
  const validRows: ProductImportRow[] = [];
  const errors: RowError[] = [];
  const seenSkus = new Set<string>();

  for (const row of rows) {
    const messages: string[] = [];

    const sku = asString(row.get('sku'));
    if (!sku) messages.push('sku majburiy');
    else if (sku.length > 64) messages.push('sku 64 belgidan oshmasligi kerak');
    else if (seenSkus.has(sku)) messages.push(`sku "${sku}" faylda takrorlangan`);
    else if (existingSkus.has(sku)) messages.push(`sku "${sku}" allaqachon mavjud`);

    const name = asString(row.get('name'));
    if (!name) messages.push('name majburiy');
    else if (name.length > 200) messages.push('name 200 belgidan oshmasligi kerak');

    const baseUnit = asString(row.get('baseUnit'));
    if (!baseUnit) messages.push('baseUnit majburiy');
    else if (baseUnit.length > 20) messages.push('baseUnit 20 belgidan oshmasligi kerak');

    const categoryName = asString(row.get('categoryName'));

    const brand = asString(row.get('brand'));
    if (brand && brand.length > 200) messages.push('brand 200 belgidan oshmasligi kerak');

    const vatRateRaw = asNumber(row.get('vatRate'));
    const vatRate = vatRateRaw ?? 12;
    if (vatRateRaw !== undefined && (Number.isNaN(vatRateRaw) || vatRateRaw < 0 || vatRateRaw > 100)) {
      messages.push("vatRate 0..100 oralig'ida bo'lishi kerak");
    }

    const minPriceRaw = asNumber(row.get('minPrice'));
    if (minPriceRaw !== undefined && (Number.isNaN(minPriceRaw) || minPriceRaw < 0)) {
      messages.push("minPrice manfiy bo'lmagan son bo'lishi kerak");
    }

    const barcode = asString(row.get('barcode'));
    if (barcode && barcode.length > 64) messages.push('barcode 64 belgidan oshmasligi kerak');

    const externalCodeInput = asString(row.get('externalCode'));
    if (externalCodeInput && externalCodeInput.length > 64) messages.push('externalCode 64 belgidan oshmasligi kerak');

    if (messages.length > 0) {
      errors.push({ row: row.rowNumber, messages });
      continue;
    }

    seenSkus.add(sku!);
    validRows.push({
      rowNumber: row.rowNumber,
      sku: sku!,
      name: name!,
      categoryName,
      brand,
      baseUnit: baseUnit!,
      vatRate,
      minPrice: minPriceRaw,
      barcode,
      // 6.4/CreateProductDto: defaults to sku when omitted (1C export needs it set).
      externalCode: externalCodeInput ?? sku!,
    });
  }

  return { totalRows: rows.length, validRows, errors };
}
