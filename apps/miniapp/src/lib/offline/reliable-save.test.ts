import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { enqueueMany, queueRepository, QueueQuotaError } from './queue';
import { setOfflineSession } from './session';
import { readyVault } from './vault-test-helper';
import { resetPreparedSession } from './session-bootstrap';

const A = { userId: 'uA', companyId: 'c1' };

describe('M1 reliable local save (stable clientId, atomic, honest failures)', () => {
  beforeEach(async () => {
    await db.queue.clear();
    await db.meta.clear();
    setOfflineSession(A);
    await readyVault(A);
  });
  afterEach(() => vi.restoreAllMocks());

  it('double-click: same clientId twice -> ONE queue item, same id returned', async () => {
    const id = crypto.randomUUID();
    const [r1, r2] = await Promise.all([queueRepository.enqueue('order', { n: 1 }, { clientId: id }), queueRepository.enqueue('order', { n: 1 }, { clientId: id })]);
    expect(r1).toBe(id);
    expect(r2).toBe(id);
    expect(await db.queue.count()).toBe(1);
    await queueRepository.enqueue('order', { n: 1 }, { clientId: id }); // later retry
    expect(await db.queue.count()).toBe(1);
  });

  it('order + visit are written atomically: a failing second write leaves NEITHER', async () => {
    const real = db.queue.put.bind(db.queue);
    let calls = 0;
    vi.spyOn(db.queue, 'put').mockImplementation(((...a: Parameters<typeof real>) => (++calls === 2 ? Promise.reject(new Error('idb boom')) : real(...a))) as never);
    await expect(enqueueMany([{ type: 'order', payload: {} }, { type: 'visit', payload: {} }])).rejects.toThrow('idb boom');
    expect(await db.queue.count()).toBe(0);
  });

  it('IndexedDB write failure throws (never resolves as saved) and writes nothing', async () => {
    vi.spyOn(db.queue, 'put').mockRejectedValue(new Error('idb down'));
    await expect(queueRepository.enqueue('order', {})).rejects.toThrow('idb down');
    expect(await db.queue.count()).toBe(0);
  });

  it('quota exceeded -> QueueQuotaError (a failure), nothing written, earlier items intact', async () => {
    const keep = await queueRepository.enqueue('order', { a: 1 });
    vi.spyOn(db.queue, 'put').mockRejectedValue(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    await expect(queueRepository.enqueue('order', { b: 1 })).rejects.toBeInstanceOf(QueueQuotaError);
    vi.restoreAllMocks();
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([keep]);
  });

  it('reload (fresh Dexie connection) keeps item, status and clientId', async () => {
    const id = await queueRepository.enqueue('order', { a: 1 });
    await queueRepository.markFailed(id, { code: 'X', message: 'y' });
    db.close();
    await db.open();
    resetPreparedSession();
    setOfflineSession(A);
    expect(await queueRepository.listAll()).toMatchObject([{ clientId: id, status: 'FAILED' }]);
  });

  it('logout / force cleanup keeps own unsynced items (PENDING/FAILED/CONFLICT), removes only SYNCED', async () => {
    const p = await queueRepository.enqueue('order', {});
    const f = await queueRepository.enqueue('visit', {});
    const c = await queueRepository.enqueue('order', {});
    const s = await queueRepository.enqueue('order', {});
    await queueRepository.markFailed(f, { code: 'X', message: 'y' });
    await queueRepository.markConflict(c, { code: 'PRICE_CHANGED', message: 'y' });
    await queueRepository.markSynced(s, 'srv');
    await queueRepository.deleteOwnEntries();
    expect((await queueRepository.listAll()).map((e) => e.clientId).sort()).toEqual([p, f, c].sort());
  });

  it('visit write fails after order write -> neither is stored (atomicity)', async () => {
    const real = db.queue.put.bind(db.queue);
    vi.spyOn(db.queue, 'put').mockImplementation(((...a: Parameters<typeof real>) => ((a[0] as { type?: string }).type === 'visit' ? Promise.reject(new Error('visit boom')) : real(...a))) as never);
    await expect(enqueueMany([{ type: 'order', payload: {} }, { type: 'visit', payload: {} }])).rejects.toThrow('visit boom');
    vi.restoreAllMocks();
    expect(await db.queue.count()).toBe(0);
  });

  it('same clientId, different payload: PENDING/FAILED is updated in place (one item, same seq)', async () => {
    const id = crypto.randomUUID();
    await queueRepository.enqueue('order', { v: 1 }, { clientId: id });
    const seq = (await queueRepository.listAll())[0]!.seq;
    await queueRepository.enqueue('order', { v: 2 }, { clientId: id });
    const all = await queueRepository.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'PENDING', seq, payload: { v: 2, clientId: id } });
    await queueRepository.markFailed(id, { code: 'X', message: 'y' });
    await queueRepository.enqueue('order', { v: 3 }, { clientId: id });
    expect((await queueRepository.listAll())[0]).toMatchObject({ status: 'PENDING', payload: { v: 3 } });
  });

  it('same clientId, different payload: SYNCED/CONFLICT/SYNCING raises CLIENT_ID_IN_USE, item untouched', async () => {
    const s = await queueRepository.enqueue('order', { v: 1 });
    await queueRepository.markSynced(s, 'srv');
    const c = await queueRepository.enqueue('order', { v: 1 });
    await queueRepository.markConflict(c, { code: 'PRICE_CHANGED', message: 'y' });
    const y = await queueRepository.enqueue('order', { v: 1 });
    await queueRepository.markSyncing([y]);
    for (const id of [s, c, y]) {
      await expect(queueRepository.enqueue('order', { v: 2 }, { clientId: id })).rejects.toMatchObject({ code: 'CLIENT_ID_IN_USE' });
      await expect(queueRepository.enqueue('order', { v: 1 }, { clientId: id })).resolves.toBe(id); // identical = no-op
    }
    expect((await queueRepository.listAll()).every((e) => (e.payload as { v: number }).v === 1)).toBe(true);
  });

  it('update race: status flips to SYNCING between pre-check and write -> CLIENT_ID_IN_USE, payload unchanged', async () => {
    const id = await queueRepository.enqueue('order', { v: 1 });
    const before = await db.queue.get(id);
    const orig = db.transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(((...a: unknown[]) =>
      db.queue.update(id, { status: 'SYNCING' }).then(() => orig(...a))) as never);
    await expect(queueRepository.enqueue('order', { v: 2 }, { clientId: id })).rejects.toMatchObject({ code: 'CLIENT_ID_IN_USE' });
    spy.mockRestore();
    const after = await db.queue.get(id);
    expect(after?.status).toBe('SYNCING');
    expect(JSON.stringify(after?._enc)).toBe(JSON.stringify(before?._enc)); // ciphertext (payload) untouched
  });

  it('clientId owned by another user is an explicit error', async () => {
    const id = await queueRepository.enqueue('order', { v: 1 });
    const B = { userId: 'uB', companyId: 'c1' };
    setOfflineSession(B);
    await readyVault(B);
    await expect(queueRepository.enqueue('order', { v: 1 }, { clientId: id })).rejects.toMatchObject({ code: 'CLIENT_ID_FOREIGN' });
    expect(await db.queue.count()).toBe(1);
  });

  it('after a successful save a NEW clientId makes a second, separate document', async () => {
    const first = crypto.randomUUID();
    await queueRepository.enqueue('visit', { a: 1 }, { clientId: first });
    const second = crypto.randomUUID();
    await queueRepository.enqueue('visit', { a: 1 }, { clientId: second });
    expect(await db.queue.count()).toBe(2);
  });
});
