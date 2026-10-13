import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { db } from './db';
import { MAX_SYNC_ATTEMPTS, backoffDelayMs, queueRepository } from './queue';
import { setOfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';

const pushSync = vi.fn();
vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: (...a: unknown[]) => pushSync(...a) }));

import { resetPushBatchLimit, runPush } from './sync-engine-core';

const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };

function asA() {
  setOfflineSession(A);
  resetPreparedSession();
}

async function entry(id: string) {
  return (await queueRepository.listAllOwners()).find((e) => e.clientId === id)!;
}

/** Makes an entry due again (skips backoff wait) without touching anything else. */
async function makeDue(id: string) {
  const { EncryptedStore } = await import('./encrypted-store');
  const store = new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId']);
  const e = (await store.get(id))!;
  await store.put({ ...e, nextAttemptAt: undefined });
}

describe('runPush status machine (TZ 8.3/8.4)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetPushBatchLimit();
    await db.queue.clear();
    await db.meta.clear();
    asA();
  });

  it('maps all five server results to local states and keeps serverId + details', async () => {
    const [ok, dup, rej, con, ret] = [
      await queueRepository.enqueue('order', { customerId: 'c' }),
      await queueRepository.enqueue('order', {}),
      await queueRepository.enqueue('order', {}),
      await queueRepository.enqueue('order', {}),
      await queueRepository.enqueue('order', {}),
    ] as [string, string, string, string, string];
    const details = { lines: [], expectedTotal: '10', serverTotal: '12' };
    pushSync.mockResolvedValue({
      results: [
        { clientId: ok, status: 'ACCEPTED', id: 'srv-1' },
        { clientId: dup, status: 'DUPLICATE', id: 'srv-2' },
        { clientId: rej, status: 'REJECTED', error: { code: 'CUSTOMER_BLOCKED', message: 'blok' } },
        { clientId: con, status: 'CONFLICT', error: { code: 'PRICE_CHANGED', message: 'narx', details } },
        { clientId: ret, status: 'RETRY', error: { code: 'SYNC_RETRY', message: 'keyinroq' } },
      ],
    });
    const out = await runPush();
    expect(out).toMatchObject({ accepted: 2, rejected: 1, conflicts: 1, retried: 1 });
    expect(await entry(ok)).toMatchObject({ status: 'SYNCED', serverId: 'srv-1' });
    expect(await entry(dup)).toMatchObject({ status: 'SYNCED', serverId: 'srv-2' });
    expect(await entry(rej)).toMatchObject({ status: 'FAILED', lastError: { code: 'CUSTOMER_BLOCKED' } });
    expect(await entry(con)).toMatchObject({ status: 'CONFLICT', lastError: { code: 'PRICE_CHANGED', details } });
    const r = await entry(ret);
    expect(r.status).toBe('PENDING');
    expect(r.attemptCount).toBe(1);
    expect(r.nextAttemptAt).toBeTruthy();
    expect(out.nextRetryInMs).toBeGreaterThan(0);
    // FAILED / CONFLICT are never auto-retried
    pushSync.mockClear();
    await runPush();
    expect(pushSync).not.toHaveBeenCalled();
  });

  it('collects server GPS verdicts only for entries that carry one', async () => {
    const v = await queueRepository.enqueue('visit', { outletId: 'o1' });
    const o = await queueRepository.enqueue('order', { outletId: 'o1' });
    pushSync.mockResolvedValue({
      results: [
        { clientId: v, status: 'ACCEPTED', gpsStatus: 'OUTSIDE_RADIUS', distanceM: '350.00' },
        { clientId: o, status: 'ACCEPTED' },
      ],
    });
    const out = await runPush();
    expect(out.visitGps).toEqual([{ clientId: v, gpsStatus: 'OUTSIDE_RADIUS', distanceM: '350.00' }]);
  });

  it('after MAX attempts a RETRY loop becomes FAILED/SYNC_MAX_ATTEMPTS', async () => {
    const id = await queueRepository.enqueue('order', {});
    pushSync.mockImplementation(async () => ({ results: [{ clientId: id, status: 'RETRY' }] }));
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      expect((await entry(id)).status).toBe('PENDING');
      await runPush();
      await makeDue(id);
    }
    expect(await entry(id)).toMatchObject({ status: 'FAILED', attemptCount: MAX_SYNC_ATTEMPTS, lastError: { code: 'SYNC_MAX_ATTEMPTS' } });
    expect(pushSync).toHaveBeenCalledTimes(MAX_SYNC_ATTEMPTS);
  });

  it('backoff grows 2s..5min with jitter', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(2_000);
    expect(backoffDelayMs(2, () => 0)).toBe(4_000);
    expect(backoffDelayMs(1, () => 1)).toBe(2_500);
    expect(backoffDelayMs(20, () => 1)).toBe(300_000);
  });

  it('never pushes another user\'s documents, and hides them', async () => {
    const mine = await queueRepository.enqueue('order', {});
    setOfflineSession(B);
    const foreign = await queueRepository.enqueue('order', {});
    asA();
    pushSync.mockImplementation(async (docs: { clientId: string }[]) => ({ results: docs.map((d) => ({ clientId: d.clientId, status: 'ACCEPTED' })) }));
    await runPush();
    const sent = pushSync.mock.calls.flatMap((c) => (c[0] as { clientId: string }[]).map((d) => d.clientId));
    expect(sent).toEqual([mine]);
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([mine]);
    expect((await entry(foreign)).status).toBe('PENDING');
    // foreign unsent work still blocks the logout wipe
    await queueRepository.markSynced(mine);
    expect(await queueRepository.unsyncedCountAllOwners()).toBe(1);
  });

  it('mid-sync cut: network error keeps items PENDING and the resend uses the SAME clientId', async () => {
    const id = await queueRepository.enqueue('order', { customerId: 'c' });
    pushSync.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const out = await runPush();
    expect(out.paused).toBe('NETWORK');
    const afterCut = await entry(id);
    expect(afterCut).toMatchObject({ status: 'PENDING', attemptCount: 1 });
    await makeDue(id);
    pushSync.mockResolvedValueOnce({ results: [{ clientId: id, status: 'DUPLICATE', id: 'srv' }] });
    await runPush();
    const clientIds = pushSync.mock.calls.map((c) => (c[0] as { clientId: string }[])[0]!.clientId);
    expect(clientIds).toEqual([id, id]);
    expect(await entry(id)).toMatchObject({ status: 'SYNCED', serverId: 'srv' });
  });

  it('app killed while SYNCING: leftover returns to PENDING on next session start', async () => {
    const id = await queueRepository.enqueue('order', {});
    await queueRepository.markSyncing([id]);
    resetPreparedSession();
    pushSync.mockResolvedValue({ results: [{ clientId: id, status: 'ACCEPTED', id: 's' }] });
    await runPush();
    expect(await entry(id)).toMatchObject({ status: 'SYNCED' });
  });

  it('401 pauses without failing or counting an attempt; 403 fails the batch', async () => {
    const id = await queueRepository.enqueue('order', {});
    const body = { code: 'X', message: { uz: 'u', ru: 'r', en: 'e' } };
    pushSync.mockRejectedValueOnce(new ApiError(401, body));
    expect((await runPush()).paused).toBe('AUTH');
    expect(await entry(id)).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    pushSync.mockRejectedValueOnce(new ApiError(403, { ...body, code: 'FORBIDDEN' }));
    await runPush();
    expect(await entry(id)).toMatchObject({ status: 'FAILED', lastError: { code: 'FORBIDDEN' } });
  });

  it('chunks to 20 per request and sends a visit before the order of the same outlet', async () => {
    const order = await queueRepository.enqueue('order', { outletId: 'o1' });
    const visit = await queueRepository.enqueue('visit', { outletId: 'o1' });
    for (let i = 0; i < 24; i++) await queueRepository.enqueue('payment', { i });
    pushSync.mockImplementation(async (docs: { clientId: string }[]) => ({ results: docs.map((d) => ({ clientId: d.clientId, status: 'ACCEPTED' })) }));
    await runPush();
    expect(pushSync.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([20, 6]);
    const flat = pushSync.mock.calls.flatMap((c) => (c[0] as { clientId: string }[]).map((d) => d.clientId));
    expect(flat.indexOf(visit)).toBeLessThan(flat.indexOf(order));
  });

  it('a failed put while applying results (quota) releases the unapplied rest to PENDING, none stuck in SYNCING', async () => {
    asA();
    const ids = [await queueRepository.enqueue('payment', { i: 1 }), await queueRepository.enqueue('payment', { i: 2 }), await queueRepository.enqueue('payment', { i: 3 })];
    pushSync.mockImplementation(async (docs: { clientId: string }[]) => ({ results: docs.map((d) => ({ clientId: d.clientId, status: 'ACCEPTED' })) }));
    const original = db.queue.put.bind(db.queue);
    let calls = 0;
    const spy = vi.spyOn(db.queue, 'put').mockImplementation(((...args: Parameters<typeof original>) => {
      calls += 1;
      // 3 markSyncing puts, then markSynced #1 ok, markSynced #2 hits quota once.
      if (calls === 5) return Promise.reject(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
      return original(...args);
    }) as never);
    await expect(runPush()).rejects.toThrow();
    spy.mockRestore();
    const states = await Promise.all(ids.map(async (id) => (await entry(id)).status));
    expect(states[0]).toBe('SYNCED');
    expect(states.slice(1)).toEqual(['PENDING', 'PENDING']);
    expect((await entry(ids[1]!)).attemptCount).toBe(0);
  });
});
