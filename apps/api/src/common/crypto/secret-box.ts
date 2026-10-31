import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Version stamped on every sealed secret; bump together with a key rotation (old versions are rejected by `open`). */
export const CURRENT_KEY_VERSION = 1;

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

/** Decodes and validates a base64 AES-256 key (exactly 32 bytes). Shared by env validation and SecretBox. */
export function decodeEncryptionKey(base64: string): Buffer | null {
  const key = Buffer.from(base64, 'base64');
  return key.length === KEY_BYTES && key.toString('base64') === base64 ? key : null;
}

/**
 * ADR-058: AES-256-GCM envelope for TOTP secrets. Fresh random 96-bit IV per
 * seal; AAD binds the ciphertext to its owner (`companyId:userId`) so a row
 * copied onto another user fails authentication on open.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const key = decodeEncryptionKey(config.getOrThrow<string>('MFA_ENCRYPTION_KEY'));
    if (!key) throw new Error('MFA_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
    this.key = key;
  }

  seal(plaintext: string, aad: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
  }

  /** Throws on a wrong AAD, tampered bytes or unknown key version. */
  open(sealed: SealedSecret, aad: string): string {
    if (sealed.keyVersion !== CURRENT_KEY_VERSION) throw new Error(`Unsupported secret key version ${sealed.keyVersion}`);
    if (sealed.tag.length !== 16) throw new Error('Invalid auth tag length');
    const decipher = createDecipheriv(ALGORITHM, this.key, sealed.iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  }
}
