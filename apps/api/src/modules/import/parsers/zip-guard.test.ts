import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../import.constants';
import { ImportFileTooLargeException } from '../import-exceptions';
import { readWorkbookRows } from './read-workbook';
import { buildTestWorkbook } from './test-workbook';
import { assertZipWithinLimits } from './zip-guard';

/** Minimal single-entry zip with a forged/real central directory. */
function craftZip(uncompressed: Buffer, declaredUncompressed = uncompressed.length): Buffer {
  const data = deflateRawSync(uncompressed);
  const name = Buffer.from('a.bin');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredUncompressed, 22);
  local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(declaredUncompressed, 24);
  cen.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, data]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cen, name, eocd]);
}

describe('import size limits', () => {
  it('rejects a high-ratio zip (zip bomb) before inflating', () => {
    const bomb = craftZip(Buffer.alloc(20 * 1024 * 1024, 0));
    expect(() => assertZipWithinLimits(bomb)).toThrow(ImportFileTooLargeException);
  });

  it('rejects declared uncompressed size above the cap', () => {
    expect(() => assertZipWithinLimits(craftZip(Buffer.from('x'), IMPORT_LIMITS.maxUncompressedBytes + 1))).toThrow(ImportFileTooLargeException);
  });

  it('accepts a normal workbook', async () => {
    const buf = await buildTestWorkbook(['code', 'name'], [['C-1', 'A']]);
    expect(await readWorkbookRows(buf)).toHaveLength(1);
  });

  it('rejects a sheet with too many data rows', async () => {
    const rows = Array.from({ length: IMPORT_LIMITS.maxDataRows + 1 }, (_, i) => [`C-${i}`, 'n']);
    const buf = await buildTestWorkbook(['code', 'name'], rows);
    await expect(readWorkbookRows(buf)).rejects.toBeInstanceOf(ImportFileTooLargeException);
  }, 60_000);

  it('rejects too many columns', async () => {
    const headers = Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`);
    const buf = await buildTestWorkbook(headers, [['x']]);
    await expect(readWorkbookRows(buf)).rejects.toBeInstanceOf(ImportFileTooLargeException);
  });
});
