import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Redis from 'ioredis';
import { afterAll, expect } from 'vitest';

// Per-test-file BullMQ prefix: queues/workers of one file never see another file's jobs.
const file = expect.getState().testPath ?? String(Math.random());
const prefix = `test-${process.pid}-${createHash('sha1').update(file).digest('hex').slice(0, 8)}`;
process.env.BULLMQ_PREFIX = prefix;

function redisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  try {
    const m = /^REDIS_URL=["']?([^"'\n]+)/m.exec(readFileSync('../../.env', 'utf8'));
    if (m) return m[1]!;
  } catch {
    /* fall through */
  }
  return 'redis://localhost:6380';
}

// Runs after the file's own afterAll hooks (apps/queues already closed); deletes only own-prefix keys.
afterAll(async () => {
  const redis = new Redis(redisUrl(), { maxRetriesPerRequest: 1 });
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
});
