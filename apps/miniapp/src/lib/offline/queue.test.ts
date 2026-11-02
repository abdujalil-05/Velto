import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { EncryptedStore } from './encrypted-store';
import { queueRepository, type QueueEntry } from './queue';
import { setOfflineSession } from './session';
import { readyVault } from './vault-test-helper';

// Direct access to backdate a row's `createdAt` — real IndexedDB (even
// fake-indexeddb) doesn't get along with vi.useFakeTimers() (Dexie's
// internal scheduling relies on real timers/microtasks), so tests
// "age" an entry by overwriting it after the fact instead of mocking time.
const rawQueueStore = new EncryptedStore<QueueEntry, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId']);
async function backdate(clientId: string, isoDate: string): Promise<void> {
  const entry = await rawQueueStore.get(clientId);
  if (!entry) throw new Error(`no queue entry ${clientId}`);
  await rawQueueStore.put({ ...entry, createdAt: isoDate });
}

describe('queueRepository (10.3 guaranteed delivery)', () => {
  beforeEach(async () => {
    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    await readyVault({ userId: 'u1', companyId: 'c1' });
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
    expect(byId.get(b)?.lastError?.code).toBe('SYNC_REJECTED');
  });

  it('pruneOld() never removes PENDING rows regardless of age (10.3: "asosiy tamoyil")', async () => {
    const oldPending = await queueRepository.enqueue('order', {});
    await backdate(oldPending, '2020-01-01T00:00:00.000Z');

    await queueRepository.pruneOld();

    const all = await queueRepository.listAll();
    expect(all.map((e) => e.clientId)).toContain(oldPending);
  });

  it('pruneOld() removes only SYNCED rows from a previous day; FAILED/CONFLICT/SYNCING survive, today\'s too', async () => {
    const staleFailed = await queueRepository.enqueue('order', {});
    await queueRepository.markFailed(staleFailed, { code: 'X', message: 'x' });
    await backdate(staleFailed, '2020-01-01T00:00:00.000Z');
    const staleConflict = await queueRepository.enqueue('order', {});
    await queueRepository.markConflict(staleConflict, { code: 'PRICE_CHANGED', message: 'x' });
    await backdate(staleConflict, '2020-01-01T00:00:00.000Z');
    const staleSynced = await queueRepository.enqueue('order', {});
    await queueRepository.markSynced(staleSynced);
    await backdate(staleSynced, '2020-01-01T00:00:00.000Z');

    const freshSynced = await queueRepository.enqueue('order', {});
    await queueRepository.markSynced(freshSynced);

    await queueRepository.pruneOld();

    const remaining = (await queueRepository.listAll()).map((e) => e.clientId);
    expect(remaining).not.toContain(staleSynced);
    expect(remaining).toContain(freshSynced);
    expect(remaining).toContain(staleFailed);
    expect(remaining).toContain(staleConflict);
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

  it('keeps new-shape visit payloads (SKIPPED + GPS fields) and legacy lat/lng-only visits intact', async () => {
    const skipped = await queueRepository.enqueue('visit', { outletId: 'o1', outcome: 'SKIPPED', skipReason: 'closed', permissionDenied: true });
    const withAcc = await queueRepository.enqueue('visit', { outletId: 'o1', outcome: 'NO_ORDER', latitude: 1, longitude: 2, accuracyM: 9, capturedAt: '2026-10-13T08:00:00.000Z' });
    const legacy = await queueRepository.enqueue('visit', { outletId: 'o1', outcome: 'ORDERED', latitude: 1, longitude: 2 });
    const byId = new Map((await queueRepository.listPending()).map((e) => [e.clientId, e]));
    expect(byId.get(skipped)?.payload).toMatchObject({ outcome: 'SKIPPED', skipReason: 'closed', permissionDenied: true });
    expect(byId.get(skipped)?.payload).not.toHaveProperty('latitude');
    expect(byId.get(withAcc)?.payload).toMatchObject({ accuracyM: 9, capturedAt: '2026-10-13T08:00:00.000Z' });
    expect(byId.get(legacy)?.payload).toMatchObject({ latitude: 1, longitude: 2 });
    expect(byId.get(legacy)?.status).toBe('PENDING');
  });

  it('resolveConflictResubmit rewrites expectedUnitPrice with the server price, keeps clientId, back to PENDING', async () => {
    const id = await queueRepository.enqueue('order', { lines: [{ productId: 'p', packagingId: 'k', qty: 1, expectedUnitPrice: '10.00' }] });
    await queueRepository.markConflict(id, {
      code: 'PRICE_CHANGED',
      message: 'narx',
      details: { lines: [{ lineIndex: 0, productId: 'p', packagingId: 'k', expectedUnitPrice: '10.00', serverUnitPrice: '12.00' }], expectedTotal: '10', serverTotal: '12' },
    });
    await expect(queueRepository.discardFailedItem('nope')).rejects.toThrow();
    const totals = await queueRepository.resolveConflictResubmit(id);
    expect(totals.serverTotal).toBe('12');
    const [e] = await queueRepository.listPending();
    expect(e).toMatchObject({ clientId: id, status: 'PENDING', attemptCount: 0 });
    expect((e?.payload.lines as { expectedUnitPrice: string }[])[0]?.expectedUnitPrice).toBe('12.00');
    await expect(queueRepository.discardFailedItem(id)).rejects.toThrow(); // PENDING is not discardable
  });

  it('discardFailedItem removes only FAILED/CONFLICT; exportPendingToJson lists unsent docs', async () => {
    const failed = await queueRepository.enqueue('order', { x: 1 });
    const pending = await queueRepository.enqueue('visit', { y: 2 });
    const synced = await queueRepository.enqueue('payment', {});
    await queueRepository.markFailed(failed, { code: 'X', message: 'x' });
    await queueRepository.markSynced(synced, 'srv');
    const exported = JSON.parse(await queueRepository.exportPendingToJson());
    expect(exported.items.map((i: { clientId: string }) => i.clientId).sort()).toEqual([failed, pending].sort());
    await queueRepository.discardFailedItem(failed);
    const counts = await queueRepository.countByStatus();
    expect(counts).toMatchObject({ PENDING: 1, FAILED: 0, SYNCED: 1, unsynced: 1 });
  });

  it('discard refused for payment idempotency CONFLICT/UNVERIFIABLE (kept, survives force logout); allowed for other FAILED', async () => {
    const c = await queueRepository.enqueue('payment', { a: 1 });
    const u = await queueRepository.enqueue('payment', { a: 2 });
    const other = await queueRepository.enqueue('payment', { a: 3 });
    await queueRepository.markFailed(c, { code: 'PAYMENT_IDEMPOTENCY_CONFLICT', message: 'x' });
    await queueRepository.markFailed(u, { code: 'PAYMENT_IDEMPOTENCY_UNVERIFIABLE', message: 'x' });
    await queueRepository.markFailed(other, { code: 'SYNC_VALIDATION_FAILED', message: 'x' });
    await expect(queueRepository.discardFailedItem(c)).rejects.toMatchObject({ code: 'NOT_DISCARDABLE' });
    await expect(queueRepository.discardFailedItem(u)).rejects.toMatchObject({ code: 'NOT_DISCARDABLE' });
    await queueRepository.discardFailedItem(other);
    await queueRepository.deleteOwnEntries();
    expect((await queueRepository.listAllOwners()).map((e) => e.clientId).sort()).toEqual([c, u].sort());
  });

  it('exportPendingToJson never includes other owners (no all scope); deleteOwnEntries keeps foreign rows', async () => {
    const mine = await queueRepository.enqueue('order', { x: 1 });
    setOfflineSession({ userId: 'u2', companyId: 'c1' });
    const theirs = await queueRepository.enqueue('order', { x: 2 });
    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    const exported = JSON.parse(await queueRepository.exportPendingToJson());
    expect(exported.items.map((i: { clientId: string }) => i.clientId)).toEqual([mine]);
    expect(JSON.stringify(exported)).not.toContain(theirs);
    expect(await queueRepository.unsyncedCountForLogout()).toBe(1); // foreign row not counted
    await queueRepository.deleteOwnEntries();
    expect((await queueRepository.listAllOwners()).map((e) => e.clientId)).toEqual([theirs]);
  });
});

describe('attempt accounting on kill / put failure', () => {
  beforeEach(async () => {
    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    await db.queue.clear();
  });

  it('N process kills mid-sync never reach SYNC_MAX_ATTEMPTS', async () => {
    const id = await queueRepository.enqueue('order', { x: 1 });
    for (let i = 0; i < 20; i++) {
      await queueRepository.markSyncing([id]);
      await queueRepository.releaseStaleSyncing(); // app restart after kill
    }
    const e = (await queueRepository.listAll()).find((x) => x.clientId === id)!;
    expect(e.status).toBe('PENDING');
    expect(e.attemptCount).toBe(0);
  });
});
