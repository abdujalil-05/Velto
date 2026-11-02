import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const statusMock = vi.fn();
vi.mock('@/lib/api/payments', () => ({ fetchReconciliationStatus: (ids: string[]) => statusMock(ids) }));

import { clearOfflineDb, db, type SealedRow } from './db';
import { bringUpVault, emergencyWipe, restoreSealedFor, resolveHeldRows } from './held-seal';
import { queueRepository, type QueueEntry } from './queue';
import { setOfflineSession } from './session';
import { resumeSync, stopSyncAndWait } from './sync-engine-core';
import { fakeKekServer, readyVault } from './vault-test-helper';

const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };
const as = (u: typeof A) => setOfflineSession(u);

async function heldPayment(code = 'PAYMENT_IDEMPOTENCY_CONFLICT') {
  const id = await queueRepository.enqueue('payment', { amount: '100.00', customerId: 'cust' });
  await queueRepository.markFailed(id, { code, message: 'x' });
  return id;
}

/** Writes a legacy v1 `sealed` row (per-row DEK wrapped by the KEK of `version`) for a held queue entry, then removes it from the queue (what the old logout did). */
async function legacySeal(clientId: string, version = 1): Promise<void> {
  const entry = (await queueRepository.listHeld()).find((e) => e.clientId === clientId) as QueueEntry;
  const { bytes } = await fakeKekServer()(A)(version);
  const kek = await crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${clientId}|${A.userId}|${A.companyId}`) },
    dek,
    new TextEncoder().encode(JSON.stringify(entry)),
  );
  const row: SealedRow = {
    clientId, ownerUserId: A.userId, ownerCompanyId: A.companyId, wrappedDek: await crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW'),
    iv, ciphertext, kekVersion: version, heldCode: entry.lastError?.code ?? '', createdAt: new Date().toISOString(),
  };
  await db.sealed.put(row);
  await db.queue.delete(clientId);
}

describe('held payments: legacy migration / resolve / wipe', () => {
  beforeEach(async () => {
    statusMock.mockReset();
    as(A);
    await db.queue.clear();
    await db.sealed.clear();
    await readyVault(A);
  });
  afterEach(() => resumeSync());

  it('legacy sealed row (v1 per-row DEK) migrates into the vault queue on the owner login; sealed copy deleted only after', async () => {
    const id = await heldPayment('PAYMENT_IDEMPOTENCY_UNVERIFIABLE');
    await legacySeal(id);
    expect(await db.queue.count()).toBe(0);
    const res = await bringUpVault(A, fakeKekServer()(A));
    expect(res).toEqual({ status: 'ready', legacyFailed: 0 });
    const [e] = await queueRepository.listNeedsAttention();
    expect(e).toMatchObject({ clientId: id, status: 'FAILED', lastError: { code: 'PAYMENT_IDEMPOTENCY_UNVERIFIABLE' }, payload: { amount: '100.00' } });
    expect((await db.queue.get(id))?._enc.v).toBe('uk1'); // now under the vault key
    expect(await db.sealed.count()).toBe(0);
  });

  it('legacy sealed row with a retired KEK version stays sealed (never deleted) and is reported', async () => {
    await legacySeal(await heldPayment(), 1);
    const getKek = fakeKekServer({ v: 2 }, { retired: [1] })(A);
    expect(await restoreSealedFor(A, getKek)).toEqual({ restored: 0, failed: 1 });
    expect(await db.sealed.count()).toBe(1);
  });

  it('other user / other company cannot restore the legacy sealed row', async () => {
    await legacySeal(await heldPayment());
    expect(await restoreSealedFor(B, fakeKekServer()(B))).toEqual({ restored: 0, failed: 0 });
    expect(await restoreSealedFor({ userId: 'uA', companyId: 'c2' }, fakeKekServer()(A))).toEqual({ restored: 0, failed: 0 });
    expect(await db.sealed.count()).toBe(1);
  });

  it('held rows are never discardable and never pushed/pruned', async () => {
    const id = await heldPayment();
    await expect(queueRepository.discardFailedItem(id)).rejects.toMatchObject({ code: 'NOT_DISCARDABLE' });
    expect(await queueRepository.listPushable(20)).toHaveLength(0);
    await queueRepository.pruneOld();
    expect(await db.queue.count()).toBe(1);
  });

  it('status OPEN / UNKNOWN / missing / network error keep the row', async () => {
    const id = await heldPayment();
    for (const status of ['OPEN', 'UNKNOWN']) {
      statusMock.mockResolvedValueOnce({ items: [{ clientId: id, status }] });
      expect(await resolveHeldRows()).toEqual([]);
    }
    statusMock.mockResolvedValueOnce({ items: [] });
    expect(await resolveHeldRows()).toEqual([]);
    statusMock.mockRejectedValueOnce(new Error('offline'));
    expect(await resolveHeldRows()).toEqual([]);
    expect(await db.queue.count()).toBe(1);
  });

  it('confirmed status removes only the matching clientId (and ignores unrequested ids)', async () => {
    const a = await heldPayment();
    const b = await heldPayment('PAYMENT_IDEMPOTENCY_UNVERIFIABLE');
    statusMock.mockResolvedValueOnce({
      items: [
        { clientId: a, status: 'EXISTING_PAYMENT_CONFIRMED' },
        { clientId: 'not-asked', status: 'NOT_POSTED_CONFIRMED' },
        { clientId: b, status: 'OPEN' },
      ],
    });
    expect(await resolveHeldRows()).toEqual([{ clientId: a, outcome: 'EXISTING_PAYMENT_CONFIRMED' }]);
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([b]);
    statusMock.mockResolvedValueOnce({ items: [{ clientId: b, status: 'NOT_POSTED_CONFIRMED' }] });
    expect(await resolveHeldRows()).toHaveLength(1);
    expect(await db.queue.count()).toBe(0);
  });

  it('stopSyncAndWait pauses resolution until a new session starts', async () => {
    await heldPayment();
    await stopSyncAndWait();
    const { runHeldMaintenance } = await import('./sync-engine-core');
    expect(await runHeldMaintenance()).toEqual([]);
    expect(statusMock).not.toHaveBeenCalled();
    as(A); // sign-in re-enables
    statusMock.mockResolvedValueOnce({ items: [] });
    await runHeldMaintenance();
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it('emergency wipe clears queue, sealed table, cache and device key', async () => {
    await heldPayment();
    await legacySeal(await heldPayment());
    window.localStorage.setItem('velto.dbKey', 'x');
    await emergencyWipe();
    expect(await db.queue.count()).toBe(0);
    expect(await db.sealed.count()).toBe(0);
    expect(await db.vault.count()).toBe(0);
    expect(window.localStorage.getItem('velto.dbKey')).toBeNull();
  });

  it('clearOfflineDb (normal logout wipe) keeps the sealed table and the wrapped vault keys', async () => {
    await legacySeal(await heldPayment());
    await clearOfflineDb({ keepQueue: false });
    expect(await db.sealed.count()).toBe(1);
    expect(await db.vault.count()).toBe(1);
  });
});
