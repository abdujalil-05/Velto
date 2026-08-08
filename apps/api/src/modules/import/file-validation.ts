import { InvalidImportFileException } from './import-exceptions';

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
