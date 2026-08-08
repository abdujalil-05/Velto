import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { EncryptedStore } from './encrypted-store';
import { queueRepository, type QueueEntry } from './queue';

// Direct access to backdate a row's `createdAt` — real IndexedDB (even
// fake-indexeddb) doesn't get along with vi.useFakeTimers() (Dexie's
// internal scheduling relies on real timers/microtasks), so tests
// "age" an entry by overwriting it after the fact instead of mocking time.
const rawQueueStore = new EncryptedStore<QueueEntry, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt']);
async function backdate(clientId: string, isoDate: string): Promise<void> {
  const entry = await rawQueueStore.get(clientId);
  if (!entry) throw new Error(`no queue entry ${clientId}`);
  await rawQueueStore.put({ ...entry, createdAt: isoDate });
}

describe('queueRepository (10.3 guaranteed delivery)', () => {
  beforeEach(async () => {
    await db.queue.clear();
  });

  afterEach(async () => {
    await db.queue.clear();
  });

  it('enqueue() assigns a clientId, defaults to PENDING, and stamps the payload with the same clientId', async () => {
    const clientId = await queueRepository.enqueue('order', { customerId: 'c1' });
    const all = await queueRepository.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.clientId).toBe(clientId);
    expect(all[0]?.status).toBe('PENDING');
    expect(all[0]?.payload.clientId).toBe(clientId);
  });

  it('listPending() returns only PENDING rows, oldest first, capped at the requested limit', async () => {
    // Explicitly staggered timestamps — enqueue()s issued back-to-back can
    // tie at millisecond resolution, which would make ordering depend on
    // Dexie's (effectively random, keyed by UUID) primary-key iteration
    // order instead of the createdAt sort under test.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await queueRepository.enqueue('order', { i });
      await backdate(id, `2024-01-0${i + 1}T00:00:00.000Z`);
      ids.push(id);
    }
    await queueRepository.markSynced(ids[1]!);

    const pending = await queueRepository.listPending(10);
    expect(pending.map((e) => e.clientId)).toEqual([ids[0], ids[2]]);

    const limited = await queueRepository.listPending(1);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.clientId).toBe(ids[0]);
  });

  it('markSynced()/markFailed() transition status without touching other rows', async () => {
    const a = await queueRepository.enqueue('order', {});
    const b = await queueRepository.enqueue('payment', {});

    await queueRepository.markSynced(a);
    await queueRepository.markFailed(b, { code: 'SYNC_REJECTED', message: 'boom' });

    const all = await queueRepository.listAll();
    const byId = new Map(all.map((e) => [e.clientId, e]));
    expect(byId.get(a)?.status).toBe('SYNCED');
    expect(byId.get(b)?.status).toBe('FAILED');
    expect(byId.get(b)?.error?.code).toBe('SYNC_REJECTED');
  });

  it('pruneOld() never removes PENDING rows regardless of age (10.3: "asosiy tamoyil")', async () => {
    const oldPending = await queueRepository.enqueue('order', {});
    await backdate(oldPending, '2020-01-01T00:00:00.000Z');

    await queueRepository.pruneOld();

    const all = await queueRepository.listAll();
    expect(all.map((e) => e.clientId)).toContain(oldPending);
  });

  it('pruneOld() removes SYNCED/FAILED rows from a previous day but keeps today\'s', async () => {
    const staleSynced = await queueRepository.enqueue('order', {});
    await queueRepository.markSynced(staleSynced);
    await backdate(staleSynced, '2020-01-01T00:00:00.000Z');

    const freshSynced = await queueRepository.enqueue('order', {});
    await queueRepository.markSynced(freshSynced);

    await queueRepository.pruneOld();

    const remaining = (await queueRepository.listAll()).map((e) => e.clientId);
    expect(remaining).not.toContain(staleSynced);
    expect(remaining).toContain(freshSynced);
  });

  it('todayByType() returns today\'s non-FAILED entries of the given type', async () => {
    const order = await queueRepository.enqueue('order', {});
    const visit = await queueRepository.enqueue('visit', {});
    const failedOrder = await queueRepository.enqueue('order', {});
    await queueRepository.markFailed(failedOrder, { code: 'X', message: 'x' });

    const todayOrders = await queueRepository.todayByType('order');
    expect(todayOrders.map((e) => e.clientId)).toEqual([order]);
    expect(todayOrders.map((e) => e.clientId)).not.toContain(visit);
    expect(todayOrders.map((e) => e.clientId)).not.toContain(failedOrder);
  });
});
