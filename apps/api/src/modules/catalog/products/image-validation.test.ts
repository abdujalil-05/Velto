import { describe, expect, it } from 'vitest';
import { InvalidImageException } from '../catalog-exceptions';
import { validateProductImage } from './image-validation';

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const webpBuffer = () => {
  const b = Buffer.alloc(16);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  return b;
};

// AppException stores its localized message as `{uz, ru, en}`, not a plain
// string — Nest's HttpException then falls back `.message` to a humanized
// class name (e.g. "Invalid Image Exception") since it expects a string
// there. The actual reason lives in the HTTP body via getResponse().details.
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidImageException);
    const body = (err as InvalidImageException).getResponse() as { details?: { reason?: string } };
    return body.details?.reason ?? '';
  }
  throw new Error('expected fn to throw');
}

describe('validateProductImage', () => {
  it('accepts a real JPEG whose declared mimetype matches its content', () => {
    const result = validateProductImage({ buffer: JPEG_HEADER, size: JPEG_HEADER.length, mimetype: 'image/jpeg' });
    expect(result).toEqual({ mimeType: 'image/jpeg', extension: 'jpg' });
  });

  it('accepts a real PNG', () => {
    const result = validateProductImage({ buffer: PNG_HEADER, size: PNG_HEADER.length, mimetype: 'image/png' });
    expect(result).toEqual({ mimeType: 'image/png', extension: 'png' });
  });

  it('accepts a real WebP', () => {
    const buf = webpBuffer();
    const result = validateProductImage({ buffer: buf, size: buf.length, mimetype: 'image/webp' });
    expect(result).toEqual({ mimeType: 'image/webp', extension: 'webp' });
  });

  it('rejects content that is not a recognized image format (SEC-040..048)', () => {
    const buf = Buffer.from('not an image');
    const reason = reasonOf(() => validateProductImage({ buffer: buf, size: buf.length, mimetype: 'image/jpeg' }));
    expect(reason).toMatch(/unrecognized image format/);
  });

  it('rejects a spoofed Content-Type — real PNG bytes declared as JPEG', () => {
    const reason = reasonOf(() =>
      validateProductImage({ buffer: PNG_HEADER, size: PNG_HEADER.length, mimetype: 'image/jpeg' }),
    );
    expect(reason).toMatch(/does not match file contents/);
  });

  it('rejects files over the 5MB limit', () => {
    const big = Buffer.concat([JPEG_HEADER, Buffer.alloc(5 * 1024 * 1024)]);
    const reason = reasonOf(() => validateProductImage({ buffer: big, size: big.length, mimetype: 'image/jpeg' }));
    expect(reason).toMatch(/exceeds 5MB/);
  });

  it('rejects a missing file', () => {
    const reason = reasonOf(() => validateProductImage(undefined));
    expect(reason).toMatch(/no file uploaded/);
  });
});
