import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: vi.fn() }));

import { clearDeviceKey } from './crypto';
import { db } from './db';
import { EncryptedStore } from './encrypted-store';
import { bringUpVault, sealOwnerForLogout, wipeLocalAfterLogout } from './held-seal';
import { LegacyPaymentsBlockedError, getLegacyPaymentRows, lockVault, refreshLegacyPaymentRows } from './vault';
import { QueueQuotaError, queueRepository } from './queue';
import { setOfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';
import { fakeKekServer } from './vault-test-helper';

const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };
const cur = { v: 1 };
type S = typeof A;
const as = (s: S) => {
  setOfflineSession(s);
  resetPreparedSession();
};
const up = (s: S) => bringUpVault(s, fakeKekServer(cur)(s));

/** A pre-vault row: encrypted under the shared device key (no `v`). */
const legacyPayment = (id: string, over: Record<string, unknown> = {}) =>
  new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq']).put({
    clientId: id, type: 'payment', status: 'PENDING', createdAt: new Date().toISOString(), userId: A.userId, companyId: A.companyId, seq: 1,
    payload: { amount: '77.00', customerId: 'cust-legacy' }, schemaVersion: 1, attemptCount: 0, ...over,
  });
const rawBytes = async (id: string) => Buffer.from((await db.queue.get(id))!._enc.ct).toString('hex');

describe('legacy device-key payments: pilot policy "new build only"', () => {
  beforeEach(async () => {
    cur.v = 1;
    lockVault();
    as(A);
    await db.queue.clear();
    await db.vault.clear();
    await db.sealed.clear();
    await db.meta.clear();
    window.localStorage.clear();
    clearDeviceKey();
    await refreshLegacyPaymentRows();
  });
  afterEach(() => vi.restoreAllMocks());

  it('A1 startup detects legacy-format rows from IndexedDB with the vault locked (no network)', async () => {
    expect(await refreshLegacyPaymentRows()).toBe(0);
    await legacyPayment('l1');
    expect(await refreshLegacyPaymentRows()).toBe(1);
    expect(getLegacyPaymentRows()).toBe(1);
  });

  it('A2 logout never reports the device safe while a legacy payment row remains (own, foreign or ownerless)', async () => {
    await up(A);
    await legacyPayment('foreign', { userId: B.userId });
    await legacyPayment('ownerless', { userId: undefined, companyId: undefined });
    expect(await sealOwnerForLogout(A)).toEqual({ state: 'pending', remainingPayments: 2 });
    await wipeLocalAfterLogout();
    expect(window.localStorage.getItem('velto.dbKey')).not.toBeNull(); // key kept, rows still readable
    expect(await db.queue.count()).toBe(2);
  });

  it('A3 only the confirmed owner (live session + KEK) migrates; another user/company never does', async () => {
    await legacyPayment('a-row');
    const before = await rawBytes('a-row');
    as(B);
    await up(B);
    expect(await rawBytes('a-row')).toBe(before);
    expect((await db.queue.get('a-row'))!._enc.v).toBeUndefined();
    lockVault();
    as(A);
    expect((await up(A)).status).toBe('ready');
    expect((await db.queue.get('a-row'))!._enc.v).toBe('uk1');
    expect(getLegacyPaymentRows()).toBe(0);
  });

  it('A3 no KEK (offline): nothing migrates, row stays legacy and detected', async () => {
    await legacyPayment('off');
    const r = await bringUpVault(A, async () => { throw new Error('offline'); });
    expect(r.status).toBe('unavailable');
    expect((await db.queue.get('off'))!._enc.v).toBeUndefined();
    expect(getLegacyPaymentRows()).toBe(1);
  });

  it('A4 UK ciphertext is read back before the legacy copy is given up: a corrupt write is rolled back to the original bytes', async () => {
    await legacyPayment('rb');
    const original = await rawBytes('rb');
    const put = db.queue.put.bind(db.queue);
    vi.spyOn(db.queue, 'put').mockImplementationOnce(((row: { _enc: { ct: ArrayBuffer } }) => {
      const ct = new Uint8Array(row._enc.ct.slice(0));
      ct[0] = ct[0]! ^ 0xff;
      return put({ ...row, _enc: { ...row._enc, ct: ct.buffer } } as never);
    }) as never);
    await up(A);
    const row = (await db.queue.get('rb'))!;
    expect(row._enc.v).toBeUndefined();
    expect(await rawBytes('rb')).toBe(original);
    expect(getLegacyPaymentRows()).toBe(1);
    expect(window.localStorage.getItem('velto.dbKey')).not.toBeNull();
    await up(A); // next attempt (clean write) migrates
    expect((await db.queue.get('rb'))!._enc.v).toBe('uk1');
  });

  it('A4b a legitimate concurrent update after our put and before the verify read is never rolled back to the old device-key blob', async () => {
    await legacyPayment('cc');
    const realTx = db.transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let injected = false;
    vi.spyOn(db, 'transaction').mockImplementation((async (...args: unknown[]) => {
      const r = await realTx(...args);
      if (r === 'moved' && !injected) {
        injected = true;
        // sync legitimately rewrites the row right after our put committed, before the verify read-back
        const cur2 = (await db.queue.get('cc'))!;
        const iv = new Uint8Array(cur2._enc.iv);
        iv[0] = iv[0]! ^ 0xff;
        await db.queue.put({ ...cur2, status: 'FAILED', _enc: { ...cur2._enc, iv } } as never);
      }
      return r;
    }) as never);
    await up(A);
    expect(injected).toBe(true);
    const now = (await db.queue.get('cc'))!;
    expect(now.status).toBe('FAILED'); // update preserved, not overwritten by the old device-key blob
    expect(now._enc.v).toBe('uk1');
  });

  it('A4c IndexedDB read error at logout seal: no throw, pending + unconfirmed, payment row untouched (not deleted)', async () => {
    await legacyPayment('rd');
    const original = await rawBytes('rd');
    vi.spyOn(queueRepository, 'sealOwnRowsToVault').mockRejectedValueOnce(new Error('idb read'));
    const r = await sealOwnerForLogout(A);
    expect(r).toEqual({ state: 'pending', remainingPayments: 0, unconfirmed: true });
    expect(await rawBytes('rd')).toBe(original);
  });

  it.each([
    ['IndexedDB error / aborted transaction', Object.assign(new Error('tx aborted'), { name: 'AbortError' })],
    ['QuotaExceededError', Object.assign(new Error('quota'), { name: 'QuotaExceededError' })],
  ])('A5 migration failure (%s) leaves the original row byte-identical and a later attempt succeeds', async (_n, err) => {
    await legacyPayment('keep');
    const original = await rawBytes('keep');
    vi.spyOn(db.queue, 'put').mockRejectedValueOnce(err);
    await up(A);
    expect(await rawBytes('keep')).toBe(original);
    expect((await db.queue.get('keep'))!._enc.v).toBeUndefined();
    await up(A);
    expect((await db.queue.get('keep'))!._enc.v).toBe('uk1');
  });

  it('B app killed mid-encryption: the crypto step never reaches IndexedDB; relaunch (fresh bring-up) migrates', async () => {
    await legacyPayment('kill');
    const original = await rawBytes('kill');
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('killed'));
    await up(A);
    expect(await rawBytes('kill')).toBe(original);
    lockVault(); // relaunch: module state gone, only IndexedDB survives
    expect(await refreshLegacyPaymentRows()).toBe(1);
    await up(A);
    expect((await db.queue.get('kill'))!._enc.v).toBe('uk1');
  });

  it('A6 unfinished legacy payments survive failed migration, pruneOld and a logout wipe', async () => {
    await legacyPayment('p-pending');
    await legacyPayment('p-failed', { status: 'FAILED', seq: 2 });
    await bringUpVault(A, async () => { throw new Error('offline'); });
    await queueRepository.pruneOld();
    await wipeLocalAfterLogout();
    expect(await db.queue.count()).toBe(2);
  });

  it('A7 unresolved legacy payment blocks creating AND sending payments (DB-level, not UI), other docs still work; owner migration unblocks', async () => {
    await up(A);
    await legacyPayment('foreign-l', { userId: B.userId });
    await expect(queueRepository.enqueue('payment', { amount: '1.00' })).rejects.toBeInstanceOf(LegacyPaymentsBlockedError);
    expect(await db.queue.count()).toBe(1);
    await expect(queueRepository.enqueue('order', { x: 1 })).resolves.toBeTruthy();

    await db.queue.delete('foreign-l');
    const id = await queueRepository.enqueue('payment', { amount: '2.00' });
    await legacyPayment('foreign-l2', { userId: B.userId });
    expect((await queueRepository.listPushable(20)).map((e) => e.clientId)).not.toContain(id); // sending blocked
    await db.queue.delete('foreign-l2');
    expect((await queueRepository.listPushable(20)).map((e) => e.clientId)).toContain(id);
  });

  it('A7 blocked/failed-save messages exist in uz, ru and en', () => {
    for (const l of ['uz', 'ru', 'en']) {
      const p = JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')).Payment;
      for (const k of ['legacyBlocked', 'storageFull', 'saveFailed']) expect(p[k], `${l}.${k}`).toMatch(/^.{30,}/);
    }
  });

  it('A8 a new payment is written under the UK only: never the device key (no device key is even created)', async () => {
    await up(A);
    const id = await queueRepository.enqueue('payment', { amount: '5.00' });
    expect((await db.queue.get(id))!._enc.v).toBe('uk1');
    expect(window.localStorage.getItem('velto.dbKey')).toBeNull();
  });

  it('B payment save: QuotaExceeded -> QueueQuotaError, IndexedDB error -> rejects; in both nothing is stored (never silently "saved")', async () => {
    await up(A);
    vi.spyOn(db.queue, 'put').mockRejectedValueOnce(Object.assign(new Error('q'), { name: 'QuotaExceededError' }));
    await expect(queueRepository.enqueue('payment', { amount: '3.00' })).rejects.toBeInstanceOf(QueueQuotaError);
    vi.spyOn(db.queue, 'put').mockRejectedValueOnce(Object.assign(new Error('io'), { name: 'UnknownError' }));
    await expect(queueRepository.enqueue('payment', { amount: '4.00' })).rejects.toThrow();
    expect(await db.queue.count()).toBe(0);
  });

  it('B logout with a failing store write does not claim "sealed": reports pending with the payment count, row intact', async () => {
    await up(A);
    await queueRepository.enqueue('order', { x: 1 });
    await legacyPayment('lo-pay', { seq: 5 });
    lockVault(); // vault gone (e.g. KEK never refetched) -> cannot seal
    const r = await sealOwnerForLogout(A);
    expect(r.state).toBe('pending');
    expect(r.remainingPayments).toBe(1);
    expect((await db.queue.get('lo-pay'))!._enc.v).toBeUndefined();
  });

  it('forced logout never deletes an unsynced PAYMENT (any status, incl. legacy/vault-locked); non-payment rows are deleted; SYNCED payment may go', async () => {
    await up(A);
    const ids: string[] = [];
    for (const st of ['PENDING', 'FAILED', 'CONFLICT'] as const) {
      const id = await queueRepository.enqueue('payment', { amount: '1.00' });
      if (st === 'FAILED') await queueRepository.markFailed(id, { code: 'X', message: 'y' });
      if (st === 'CONFLICT') await queueRepository.markConflict(id, { code: 'X', message: 'y' });
      ids.push(id);
    }
    await legacyPayment('leg-force');
    const order = await queueRepository.enqueue('order', { x: 1 });
    await queueRepository.deleteOwnEntries();
    expect(await db.queue.get(order)).toBeUndefined();
    for (const id of [...ids, 'leg-force']) expect(await db.queue.get(id)).toBeDefined();
    // vault locked at that moment: rows are unreadable, so they are skipped and kept as-is
    lockVault();
    await queueRepository.deleteOwnEntries();
    expect(await db.queue.count()).toBe(4);
    expect((await sealOwnerForLogout(A)).state).toBe('pending'); // legacy row could not be sealed: explicit warning
    // owner's next login restores the same clientIds (no re-send duplication)
    await up(A);
    expect((await queueRepository.listAll()).map((e) => e.clientId).sort()).toEqual([...ids, 'leg-force'].sort());
  });
});
