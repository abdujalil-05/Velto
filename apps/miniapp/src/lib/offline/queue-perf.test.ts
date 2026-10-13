import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { queueRepository } from './queue';
import { setOfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';

const pushSync = vi.fn();
vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: (...a: unknown[]) => pushSync(...a) }));

import { resetPushBatchLimit, runPush } from './sync-engine-core';

// NFR-PERF generous thresholds (fake-indexeddb, CI-safe): the real device
// budgets are p95 <= 300 ms local save and 100 pending docs flushed in <= 30 s.
describe('offline perf budgets (NFR-PERF-004..006)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetPushBatchLimit();
    await db.queue.clear();
    await db.meta.clear();
    setOfflineSession({ userId: 'uP', companyId: 'cP' });
    resetPreparedSession();
  });

  it('local enqueue p95 <= 300 ms over 50 saves', async () => {
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      await queueRepository.enqueue('order', { customerId: 'c', lines: [{ productId: 'p', qty: i }] });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(times.length * 0.95) - 1]!).toBeLessThanOrEqual(300);
  });

  it('flushes 100 pending docs in batches of <= 20 within 30 s, all ACKed', async () => {
    for (let i = 0; i < 100; i++) await queueRepository.enqueue('order', { i });
    pushSync.mockImplementation(async (docs: { clientId: string }[]) => {
      expect(docs.length).toBeLessThanOrEqual(20);
      return { results: docs.map((d) => ({ clientId: d.clientId, status: 'ACCEPTED', id: `s-${d.clientId}` })) };
    });
    const t0 = performance.now();
    const out = await runPush();
    expect(performance.now() - t0).toBeLessThan(30_000);
    expect(out.accepted).toBe(100);
    expect((await queueRepository.countByStatus()).unsynced).toBe(0);
  });
});
