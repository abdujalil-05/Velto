import { IMPORT_LIMITS } from '../import.constants';
import { ImportFileTooLargeException, InvalidImportFileException } from '../import-exceptions';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/**
 * Zip-bomb guard: reads only the central directory (no inflating) and rejects
 * archives whose declared uncompressed size / ratio / entry count is excessive.
 */
export function assertZipWithinLimits(buffer: Buffer): void {
  const minEocd = 22;
  let eocd = -1;
  for (let i = buffer.length - minEocd; i >= Math.max(0, buffer.length - minEocd - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new InvalidImportFileException('zip end-of-central-directory not found');

  const entries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries > IMPORT_LIMITS.maxZipEntries) throw new ImportFileTooLargeException('too many archive entries');
  if (cdOffset + cdSize > buffer.length) throw new InvalidImportFileException('corrupt zip directory');

  let pos = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CEN_SIG) throw new InvalidImportFileException('corrupt zip directory');
    total += buffer.readUInt32LE(pos + 24);
    if (total > IMPORT_LIMITS.maxUncompressedBytes) throw new ImportFileTooLargeException('uncompressed size limit exceeded');
    pos += 46 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  if (total > buffer.length * IMPORT_LIMITS.maxCompressionRatio) throw new ImportFileTooLargeException('compression ratio limit exceeded');
}
