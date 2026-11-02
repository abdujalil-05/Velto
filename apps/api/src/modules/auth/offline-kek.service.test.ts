import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { OfflineKekVersionRetiredException } from '../../common/auth/auth-exceptions';
import { validateEnv } from '../../common/config/env.schema';
import { RateLimitedException } from '../../common/throttle/user-throttler.guard';
import type { AuditLogService } from '../../common/audit/audit-log.service';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { OfflineKekService } from './offline-kek.service';

const CURRENT = 'current-offline-kek-secret-at-least-32-chars!!';
const OLD1 = 'old-one-offline-kek-secret-at-least-32-chars!!!';
function svc(env: Record<string, unknown>) {
  const config = { get: (k: string, d?: unknown) => env[k] ?? d, getOrThrow: (k: string) => env[k] } as unknown as ConfigService;
  return new OfflineKekService(config, {} as TenantPrismaService, {} as AuditLogService, {} as LoginRateLimiterService);
}
const hmac = (secret: string, label: string) => createHmac('sha256', secret).update(label).digest('base64url');

describe('OfflineKekService.derive (keyring)', () => {
  it('v1 output unchanged (label v1), 32 bytes base64url, currentVersion reported', () => {
    const r = svc({ OFFLINE_KEK_SECRET: CURRENT }).derive('c1', 'u1');
    expect(r).toEqual({ kek: hmac(CURRENT, 'velto-offline-kek:v1:c1:u1'), version: 1, currentVersion: 1 });
    expect(Buffer.from(r.kek, 'base64url')).toHaveLength(32);
  });
  it('stable for same identity, differs by user and company', () => {
    const s = svc({ OFFLINE_KEK_SECRET: CURRENT });
    expect(s.derive('c1', 'u1')).toEqual(s.derive('c1', 'u1'));
    expect(s.derive('c1', 'u2').kek).not.toBe(s.derive('c1', 'u1').kek);
    expect(s.derive('c2', 'u1').kek).not.toBe(s.derive('c1', 'u1').kek);
  });
  it('previous version returns its old key; unknown/retired/future => retired', () => {
    const s = svc({ OFFLINE_KEK_SECRET: CURRENT, OFFLINE_KEK_VERSION: 3, OFFLINE_KEK_PREVIOUS_SECRETS: `1:${OLD1}` });
    expect(s.derive('c1', 'u1').version).toBe(3);
    expect(s.derive('c1', 'u1', 1)).toEqual({ kek: hmac(OLD1, 'velto-offline-kek:v1:c1:u1'), version: 1, currentVersion: 3 });
    expect(() => s.derive('c1', 'u1', 2)).toThrow(OfflineKekVersionRetiredException);
    expect(() => s.derive('c1', 'u1', 4)).toThrow(OfflineKekVersionRetiredException);
  });
});

describe('OFFLINE_KEK env keyring validation', () => {
  const base = {
    DATABASE_URL: 'x', DATABASE_SYSTEM_URL: 'x', REDIS_URL: 'x', JWT_ACCESS_SECRET: 'x'.repeat(32),
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), OFFLINE_KEK_SECRET: CURRENT,
    S3_ENDPOINT: 'x', S3_ACCESS_KEY: 'x', S3_SECRET_KEY: 'x', S3_BUCKET: 'x',
  };
  it('defaults to version 1, accepts a valid keyring', () => {
    expect(validateEnv(base).OFFLINE_KEK_VERSION).toBe(1);
    expect(validateEnv({ ...base, OFFLINE_KEK_VERSION: '3', OFFLINE_KEK_PREVIOUS_SECRETS: `1:${OLD1};2:${OLD1}x` }).OFFLINE_KEK_VERSION).toBe(3);
  });
  it.each([
    ['version >= current', { OFFLINE_KEK_VERSION: '2', OFFLINE_KEK_PREVIOUS_SECRETS: `2:${OLD1}` }],
    ['short secret', { OFFLINE_KEK_VERSION: '2', OFFLINE_KEK_PREVIOUS_SECRETS: '1:short' }],
    ['duplicate', { OFFLINE_KEK_VERSION: '3', OFFLINE_KEK_PREVIOUS_SECRETS: `1:${OLD1};1:${OLD1}` }],
    ['bad format', { OFFLINE_KEK_VERSION: '3', OFFLINE_KEK_PREVIOUS_SECRETS: OLD1 }],
    ['version 0', { OFFLINE_KEK_VERSION: '0' }],
  ])('rejects %s (error text never echoes the secret)', (_n, extra) => {
    try {
      validateEnv({ ...base, ...extra });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(OLD1);
    }
  });
});

describe('LoginRateLimiterService.hit', () => {
  it('Redis down => 503 fail-closed (not 200)', async () => {
    const lim = new LoginRateLimiterService({ eval: () => Promise.reject(new Error('down')) } as never);
    await expect(lim.hit('k', 10, 60)).rejects.toMatchObject({ status: 503 });
  });
  it('over limit => RateLimitedException (429)', async () => {
    let n = 0;
    const lim = new LoginRateLimiterService({ eval: () => Promise.resolve(++n) } as never);
    for (let i = 0; i < 3; i++) await lim.hit('k', 3, 60);
    await expect(lim.hit('k', 3, 60)).rejects.toBeInstanceOf(RateLimitedException);
  });
});
