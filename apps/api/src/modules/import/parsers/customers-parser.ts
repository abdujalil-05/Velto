import type { RowError } from '../import.constants';
import { asNumber, asString, isBlankCell, readWorkbookRows } from './read-workbook';

export interface CustomerImportRow {
  rowNumber: number;
  code: string;
  name: string;
  phone?: string;
  contactPerson?: string;
  paymentTermDays: number;
  outletName: string;
  outletAddress?: string;
  outletLatitude?: number;
  outletLongitude?: number;
}

export interface ParseResult<T> {
  totalRows: number;
  validRows: T[];
  errors: RowError[];
}

/**
 * 9.2/11.4: validates every row against the same rules CreateCustomerDto
 * enforces for a single record (6.3), plus file-local and DB-existing `code`
 * uniqueness (`existingCodes`, loaded once by the caller — not re-queried
 * per row). Duplicate-detection warnings (phone/name similarity,
 * duplicate-detection.ts) are deliberately NOT run here: they're per-row DB
 * queries (including a trigram similarity scan) that would multiply into
 * thousands of extra queries for a 1000-row file — out of scope for MVP
 * bulk import; the fuzzy-warning UX still applies when adding/editing a
 * customer individually afterwards.
 */
export async function parseCustomersWorkbook(buffer: Buffer, existingCodes: Set<string>): Promise<ParseResult<CustomerImportRow>> {
  const rows = await readWorkbookRows(buffer);
  const validRows: CustomerImportRow[] = [];
  const errors: RowError[] = [];
  const seenCodes = new Set<string>();

  for (const row of rows) {
    const messages: string[] = [];

    const code = asString(row.get('code'));
    if (!code) messages.push('code majburiy');
    else if (code.length > 64) messages.push('code 64 belgidan oshmasligi kerak');
    else if (seenCodes.has(code)) messages.push(`code "${code}" faylda takrorlangan`);
    else if (existingCodes.has(code)) messages.push(`code "${code}" allaqachon mavjud`);

    const name = asString(row.get('name'));
    if (!name) messages.push('name majburiy');
    else if (name.length > 200) messages.push('name 200 belgidan oshmasligi kerak');

    const phone = asString(row.get('phone'));
    if (phone && phone.length > 32) messages.push('phone 32 belgidan oshmasligi kerak');

    const contactPerson = asString(row.get('contactPerson'));
    if (contactPerson && contactPerson.length > 200) messages.push('contactPerson 200 belgidan oshmasligi kerak');

    const paymentTermDaysRaw = asNumber(row.get('paymentTermDays'));
    const paymentTermDays = paymentTermDaysRaw ?? 0;
    if (
      paymentTermDaysRaw !== undefined &&
      (Number.isNaN(paymentTermDaysRaw) || paymentTermDaysRaw < 0 || !Number.isInteger(paymentTermDaysRaw))
    ) {
      messages.push("paymentTermDays manfiy bo'lmagan butun son bo'lishi kerak");
    }

    // 6.3: a customer is never useful without at least one outlet — default
    // the outlet name to the customer's own name when left blank.
    const outletName = asString(row.get('outletName')) ?? name;
    const outletAddress = asString(row.get('outletAddress'));

    const latCell = row.get('outletLatitude');
    const lngCell = row.get('outletLongitude');
    const hasLat = !isBlankCell(latCell);
    const hasLng = !isBlankCell(lngCell);
    const outletLatitude = asNumber(latCell);
    const outletLongitude = asNumber(lngCell);

    if (hasLat !== hasLng) messages.push('outletLatitude va outletLongitude ikkalasi ham kiritilishi kerak');
    if (hasLat && (Number.isNaN(outletLatitude) || outletLatitude! < -90 || outletLatitude! > 90)) {
      messages.push("outletLatitude -90..90 oralig'ida bo'lishi kerak");
    }
    if (hasLng && (Number.isNaN(outletLongitude) || outletLongitude! < -180 || outletLongitude! > 180)) {
      messages.push("outletLongitude -180..180 oralig'ida bo'lishi kerak");
    }

    if (messages.length > 0) {
      errors.push({ row: row.rowNumber, messages });
      continue;
    }

    seenCodes.add(code!);
    validRows.push({
      rowNumber: row.rowNumber,
      code: code!,
      name: name!,
      phone,
      contactPerson,
      paymentTermDays,
      outletName: outletName!,
      outletAddress,
      outletLatitude: hasLat ? outletLatitude : undefined,
      outletLongitude: hasLng ? outletLongitude : undefined,
    });
  }

  return { totalRows: rows.length, validRows, errors };
}
