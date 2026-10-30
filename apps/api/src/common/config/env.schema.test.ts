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
  S3_ENDPOINT: 'http://x',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  S3_BUCKET: 'c',
};

describe('env.schema queue timeouts', () => {
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
