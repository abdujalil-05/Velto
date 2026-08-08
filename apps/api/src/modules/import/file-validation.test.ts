import { describe, expect, it } from 'vitest';
import { validateImportFile } from './file-validation';
import { InvalidImportFileException } from './import-exceptions';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

describe('validateImportFile', () => {
  it('accepts a buffer with the ZIP/xlsx signature and the correct declared MIME type', () => {
    const file = { buffer: ZIP_MAGIC, size: ZIP_MAGIC.length, mimetype: XLSX_MIME, originalname: 'test.xlsx' };
    expect(validateImportFile(file)).toBe(ZIP_MAGIC);
  });

  it('rejects when no file was uploaded', () => {
    expect(() => validateImportFile(undefined)).toThrow(InvalidImportFileException);
  });

  it('rejects a file over the 10MB limit', () => {
    const file = { buffer: ZIP_MAGIC, size: 11 * 1024 * 1024, mimetype: XLSX_MIME, originalname: 'test.xlsx' };
    expect(() => validateImportFile(file)).toThrow(InvalidImportFileException);
  });

  it('rejects a declared MIME type that is not xlsx', () => {
    const file = { buffer: ZIP_MAGIC, size: ZIP_MAGIC.length, mimetype: 'text/csv', originalname: 'test.csv' };
    expect(() => validateImportFile(file)).toThrow(InvalidImportFileException);
  });

  it('rejects content that does not start with the ZIP signature, even with a spoofed MIME type', () => {
    const notAZip = Buffer.from('this is not a zip file at all');
    const file = { buffer: notAZip, size: notAZip.length, mimetype: XLSX_MIME, originalname: 'fake.xlsx' };
    expect(() => validateImportFile(file)).toThrow(InvalidImportFileException);
  });
});
