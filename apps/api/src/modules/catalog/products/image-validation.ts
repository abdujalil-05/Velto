import { InvalidImageException } from '../catalog-exceptions';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB, per SEC-040..048

interface ImageSignature {
  mime: string;
  extension: string;
  matches: (buf: Buffer) => boolean;
}

// Content sniffing (magic bytes), not the client-supplied mimetype/filename —
// SEC-040..048 requires checking MIME + extension + size, and a spoofed
// upload (e.g. a script renamed to .jpg with a forged Content-Type) would
// pass a naive extension/mimetype-only check.
const SIGNATURES: ImageSignature[] = [
  {
    mime: 'image/jpeg',
    extension: 'jpg',
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    extension: 'png',
    matches: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: 'image/webp',
    extension: 'webp',
    matches: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

export interface ValidatedImage {
  mimeType: string;
  extension: string;
}

type UploadedFile = { buffer: Buffer; size: number; mimetype: string } | undefined;

export function validateProductImage(file: UploadedFile): ValidatedImage {
  if (!file) {
    throw new InvalidImageException('no file uploaded');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new InvalidImageException('file exceeds 5MB limit');
  }

  const signature = SIGNATURES.find((s) => s.matches(file.buffer));
  if (!signature) {
    throw new InvalidImageException('unrecognized image format (only JPEG/PNG/WebP are allowed)');
  }
  if (file.mimetype !== signature.mime) {
    throw new InvalidImageException('declared content type does not match file contents');
  }

  return { mimeType: signature.mime, extension: signature.extension };
}
