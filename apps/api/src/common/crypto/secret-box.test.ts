import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { validateEnv } from '../config/env.schema';
import { SecretBox } from './secret-box';

const cfg = (key: string) => ({ getOrThrow: () => key }) as unknown as ConfigService;
const key = () => randomBytes(32).toString('base64');

describe('SecretBox (AES-256-GCM)', () => {
  const box = new SecretBox(cfg(key()));

  it('round-trips; fresh 12-byte IV per seal; ciphertext is not the plaintext', () => {
    const a = box.seal('JBSWY3DPEHPK3PXP', 'co:user');
    const b = box.seal('JBSWY3DPEHPK3PXP', 'co:user');
    expect(a.iv).toHaveLength(12);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('JBSWY3');
    expect(box.open(a, 'co:user')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects another AAD (row copied to another user), tampering and an unknown key version', () => {
    const s = box.seal('secret', 'co:user');
    expect(() => box.open(s, 'co:other')).toThrow();
    expect(() => box.open({ ...s, ciphertext: Buffer.from(s.ciphertext.map((x) => x ^ 1)) }, 'co:user')).toThrow();
    expect(() => box.open({ ...s, keyVersion: 99 }, 'co:user')).toThrow();
    expect(() => new SecretBox(cfg(key())).open(s, 'co:user')).toThrow(); // different key
  });

  it('refuses a key that is not exactly 32 bytes', () => {
    expect(() => new SecretBox(cfg(randomBytes(16).toString('base64')))).toThrow();
  });
});

describe('env MFA_ENCRYPTION_KEY', () => {
  const base = {
    DATABASE_URL: 'postgresql://x', DATABASE_SYSTEM_URL: 'postgresql://x', REDIS_URL: 'redis://x',
    JWT_ACCESS_SECRET: 'x'.repeat(32), S3_ENDPOINT: 'http://x', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b', S3_BUCKET: 'c',
  };
  it('is required and must decode to 32 bytes', () => {
    expect(() => validateEnv(base)).toThrow();
    expect(() => validateEnv({ ...base, MFA_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow();
    expect(() => validateEnv({ ...base, MFA_ENCRYPTION_KEY: 'not base64!!' })).toThrow();
    expect(validateEnv({ ...base, MFA_ENCRYPTION_KEY: key() }).MFA_ENCRYPTION_KEY).toBeTruthy();
  });
});
