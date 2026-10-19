import { InvalidImportFileException } from './import-exceptions';
import type { SpreadsheetFormat } from './parsers/read-workbook';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10MB — comfortably above what 2000 rows (11.4) produce
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type UploadedFile = { buffer: Buffer; size: number; mimetype: string; originalname: string } | undefined;

/**
 * SEC-040..048: content-sniff before trusting the upload. .xlsx is a ZIP
 * archive, so this checks for the ZIP local-file-header signature (the
 * "PK\x03\x04" magic bytes every xlsx produced by Excel/exceljs starts
 * with) rather than trusting the client-declared MIME type or filename
 * extension alone.
 */
export function validateImportFile(file: UploadedFile): Buffer {
  if (!file) {
    throw new InvalidImportFileException('no file uploaded');
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new InvalidImportFileException('file exceeds 10MB limit');
  }
  if (file.mimetype !== XLSX_MIME) {
    throw new InvalidImportFileException('declared content type is not an xlsx spreadsheet');
  }

  const b = file.buffer;
  const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  if (!isZip) {
    throw new InvalidImportFileException('unrecognized file format (expected an .xlsx file)');
  }

  return b;
}

// Browsers/OSes declare .csv inconsistently (Windows: application/vnd.ms-excel).
const CSV_MIMES = new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']);

/**
 * .xlsx (validated exactly as validateImportFile) or UTF-8 .csv. A CSV is
 * accepted only by extension + a CSV-ish declared type, and must be valid
 * UTF-8 text with no NUL bytes (rejects binaries renamed to .csv).
 */
export function validateSpreadsheetUpload(file: UploadedFile): { buffer: Buffer; format: SpreadsheetFormat } {
  if (!file) throw new InvalidImportFileException('no file uploaded');
  const isCsv = file.originalname.toLowerCase().endsWith('.csv') && CSV_MIMES.has(file.mimetype);
  if (!isCsv) return { buffer: validateImportFile(file), format: 'xlsx' };

  if (file.size > MAX_IMPORT_BYTES) throw new InvalidImportFileException('file exceeds 10MB limit');
  const b = file.buffer;
  if (b.length === 0 || b.includes(0)) throw new InvalidImportFileException('unrecognized file format (expected a UTF-8 .csv file)');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new InvalidImportFileException('csv is not valid UTF-8');
  }
  return { buffer: b, format: 'csv' };
}
