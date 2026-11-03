import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read as text (a TS import would pull packages/database outside this workspace's rootDir).
const poolConfigSrc = readFileSync(resolve(__dirname, '../../../../../packages/database/src/pool-config.ts'), 'utf8');
const poolConst = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+);`).exec(poolConfigSrc)![1]);
const DEFAULT_APP_POOL_SIZE = poolConst('DEFAULT_APP_POOL_SIZE');
const DEFAULT_SYSTEM_POOL_SIZE = poolConst('DEFAULT_SYSTEM_POOL_SIZE');
const DEFAULT_POOL_TIMEOUT_S = poolConst('DEFAULT_POOL_TIMEOUT_S');
const MAX_POOL_SIZE = poolConst('MAX_POOL_SIZE');
const MAX_POOL_TIMEOUT_S = poolConst('MAX_POOL_TIMEOUT_S');

const base = {
  DATABASE_URL: 'postgresql://x',
  DATABASE_SYSTEM_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  OFFLINE_KEK_SECRET: 'k'.repeat(32),
  S3_ENDPOINT: 'http://x',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  S3_BUCKET: 'c',
};

describe('env.schema queue timeouts', () => {
  it('rejects a missing or short OFFLINE_KEK_SECRET', () => {
    const { OFFLINE_KEK_SECRET: _omit, ...without } = base;
    expect(() => validateEnv(without)).toThrow();
    expect(() => validateEnv({ ...base, OFFLINE_KEK_SECRET: 'k'.repeat(31) })).toThrow();
  });

  it('applies defaults', () => {
    const env = validateEnv(base);
    expect(env.QUEUE_ENQUEUE_TIMEOUT_MS).toBe(3000);
    expect(env.ABANDONED_QUEUED_MS).toBe(86_400_000);
  });

  it.each([
    ['QUEUE_ENQUEUE_TIMEOUT_MS', '-5'],
    ['QUEUE_ENQUEUE_TIMEOUT_MS', 'abc'],
    ['QUEUE_ENQUEUE_TIMEOUT_MS', '99'],
    ['QUEUE_ENQUEUE_TIMEOUT_MS', '60001'],
    ['ABANDONED_QUEUED_MS', '-1'],
    ['ABANDONED_QUEUED_MS', 'soon'],
    ['ABANDONED_QUEUED_MS', '899999'],
  ])('rejects %s=%s with a clear error', (key, value) => {
    expect(() => validateEnv({ ...base, [key]: value })).toThrow(new RegExp(`Invalid environment configuration[\\s\\S]*${key}`));
  });
});

describe('env.schema prisma pool', () => {
  it('defaults match packages/database pool-config', () => {
    const env = validateEnv(base);
    expect(env.PRISMA_POOL_SIZE).toBe(DEFAULT_APP_POOL_SIZE);
    expect(env.PRISMA_SYSTEM_POOL_SIZE).toBe(DEFAULT_SYSTEM_POOL_SIZE);
    expect(env.PRISMA_POOL_TIMEOUT_S).toBe(DEFAULT_POOL_TIMEOUT_S);
  });

  it('upper bounds match packages/database pool-config', () => {
    expect(() => validateEnv({ ...base, PRISMA_POOL_SIZE: String(MAX_POOL_SIZE) })).not.toThrow();
    expect(() => validateEnv({ ...base, PRISMA_POOL_SIZE: String(MAX_POOL_SIZE + 1) })).toThrow();
    expect(() => validateEnv({ ...base, PRISMA_POOL_TIMEOUT_S: String(MAX_POOL_TIMEOUT_S) })).not.toThrow();
    expect(() => validateEnv({ ...base, PRISMA_POOL_TIMEOUT_S: String(MAX_POOL_TIMEOUT_S + 1) })).toThrow();
  });

  it.each([
    ['PRISMA_POOL_SIZE', '0'],
    ['PRISMA_POOL_SIZE', 'abc'],
    ['PRISMA_POOL_SIZE', '1.5'],
    ['PRISMA_SYSTEM_POOL_SIZE', '-1'],
    ['PRISMA_SYSTEM_POOL_SIZE', '96'],
    ['PRISMA_POOL_TIMEOUT_S', '0'],
    ['PRISMA_POOL_TIMEOUT_S', '121'],
  ])('rejects %s=%s with a clear error', (key, value) => {
    expect(() => validateEnv({ ...base, [key]: value })).toThrow(new RegExp(`Invalid environment configuration[\\s\\S]*${key}`));
  });
});

describe('report tenant quota env', () => {
  it('defaults 1/5, health cache 1000; tenant cap must be <= REPORT_MAX_CONCURRENCY', () => {
    const env = validateEnv(base);
    expect([env.REPORT_TENANT_MAX_CONCURRENCY, env.REPORT_TENANT_QUEUE_MAX, env.HEALTH_READY_CACHE_MS]).toEqual([1, 5, 1000]);
    expect(() => validateEnv({ ...base, REPORT_MAX_CONCURRENCY: '2', REPORT_TENANT_MAX_CONCURRENCY: '3' })).toThrow(/REPORT_TENANT_MAX_CONCURRENCY/);
    expect(() => validateEnv({ ...base, PRISMA_POOL_SIZE: '36', REPORT_MAX_CONCURRENCY: '3', REPORT_TENANT_MAX_CONCURRENCY: '3' })).not.toThrow();
  });
});

describe('prisma pool vs limiter lanes', () => {
  it('requires PRISMA_POOL_SIZE >= 6 x (report + dashboard concurrency) + 6', () => {
    expect(() => validateEnv(base)).not.toThrow(); // default pool 30 == 6 x (2 + 2) + 6
    expect(() => validateEnv({ ...base, PRISMA_POOL_SIZE: '30', REPORT_MAX_CONCURRENCY: '3' })).toThrow(/PRISMA_POOL_SIZE/);
    expect(() => validateEnv({ ...base, PRISMA_POOL_SIZE: '36', REPORT_MAX_CONCURRENCY: '3' })).not.toThrow();
    expect(() => validateEnv({ ...base, PRISMA_POOL_SIZE: '29' })).toThrow(/PRISMA_POOL_SIZE/);
  });
});

describe('OFFLINE_KEK_SECRET placeholder guard', () => {
  const PH = 'change-me-offline-kek-secret-min-32-characters-long';
  const real = 'Zk3vQ9xL2mP7wR5tY8uN1bC4dF6gH0jKaS3eV9zX2cB5nM7q';
  it.each(['production'])('rejects placeholders in %s without echoing them', (NODE_ENV) => {
    for (const bad of [PH, 'REPLACE_ME_generate_with_openssl_rand_base64_48', 'ci-only-offline-kek-secret-min-32-chars-xx']) {
      let msg = '';
      try { validateEnv({ ...base, NODE_ENV, OFFLINE_KEK_SECRET: bad }); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain('OFFLINE_KEK_SECRET');
      expect(msg).not.toContain(bad);
    }
  });
  it('rejects NODE_ENV=staging (enum, boot fails)', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'staging' })).toThrow();
  });
  it.each(['development', 'test'])('accepts placeholder in %s', (NODE_ENV) => {
    expect(() => validateEnv({ ...base, NODE_ENV, OFFLINE_KEK_SECRET: PH })).not.toThrow();
  });
  it('accepts a random 48-char secret in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', OFFLINE_KEK_SECRET: real, REDIS_URL: 'redis://:Rnd0mRedisPw@x' })).not.toThrow();
  });
  it('rejects a placeholder inside PREVIOUS_SECRETS in production, not echoing it', () => {
    let msg = '';
    try { validateEnv({ ...base, NODE_ENV: 'production', OFFLINE_KEK_SECRET: real, OFFLINE_KEK_VERSION: '2', OFFLINE_KEK_PREVIOUS_SECRETS: `1:${PH}` }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('OFFLINE_KEK_PREVIOUS_SECRETS');
    expect(msg).not.toContain(PH);
    expect(() => validateEnv({ ...base, NODE_ENV: 'development', OFFLINE_KEK_VERSION: '2', OFFLINE_KEK_PREVIOUS_SECRETS: `1:${PH}` })).not.toThrow();
  });
});

describe('production example-credential guard', () => {
  const real = 'Zk3vQ9xL2mP7wR5tY8uN1bC4dF6gH0jKaS3eV9zX2cB5nM7q';
  const prod = { ...base, NODE_ENV: 'production', OFFLINE_KEK_SECRET: real, JWT_ACCESS_SECRET: real };
  const bad: Array<[string, string]> = [
    ['JWT_ACCESS_SECRET', 'change-me-access-secret-min-32-characters-long'],
    ['JWT_ACCESS_SECRET', 'ci-only-secret-not-for-real-use-min-32-chars'],
    ['S3_ACCESS_KEY', 'velto'],
    ['S3_ACCESS_KEY', 'velto-ci'],
    ['S3_ACCESS_KEY', 'minioadmin'],
    ['S3_SECRET_KEY', 'velto12345'],
    ['S3_SECRET_KEY', 'velto-ci-secret'],
    ['S3_SECRET_KEY', 'minioadmin'],
    ['DATABASE_URL', 'postgresql://velto_app:velto_app@localhost:5433/velto_dev'],
    ['DATABASE_SYSTEM_URL', 'postgresql://velto_system:velto_system@localhost:5433/velto_dev'],
    ['DATABASE_URL', 'postgresql://velto:velto@localhost:5432/velto_ci'],
    ['REDIS_URL', 'redis://:velto@localhost:6379'],
  ];
  it.each(bad)('rejects %s=%s in production without echoing it', (key, value) => {
    let msg = '';
    try { validateEnv({ ...prod, [key]: value }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(key);
    expect(msg).not.toContain(value);
  });
  it.each(['development', 'test'])('accepts the same examples in %s', (NODE_ENV) => {
    const env: Record<string, string> = { ...base, NODE_ENV };
    for (const [k, v] of bad) env[k] = v;
    expect(() => validateEnv(env)).not.toThrow();
  });
  it('accepts real values in production', () => {
    expect(() => validateEnv({ ...prod, DATABASE_URL: 'postgresql://velto_app:Rnd0mPw@db:5432/velto', REDIS_URL: 'redis://:Rnd0mRedisPw@localhost:6379' })).not.toThrow();
  });
  it('rejects a REDIS_URL without a password in production', () => {
    expect(() => validateEnv({ ...prod, REDIS_URL: 'redis://localhost:6379' })).toThrow(/REDIS_URL/);
  });
});
