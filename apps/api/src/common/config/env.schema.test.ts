import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

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
