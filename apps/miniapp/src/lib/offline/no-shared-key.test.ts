import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: vi.fn() }));

import { clearDeviceKey } from './crypto';
import { db } from './db';
import { EncryptedStore } from './encrypted-store';
import { bringUpVault, sealOwnerForLogout, wipeLocalAfterLogout } from './held-seal';
import { queueRepository } from './queue';
import { offlineRepository } from './repository';
import { setOfflineSession } from './session';
import { endSessionSealing } from './session-end';
import { resetPreparedSession } from './session-bootstrap';
import { stopSyncAndWait } from './sync-engine-core';
import {
  ForeignLegacyBlockedError, VaultUnavailableError, getForeignLegacyRows, getVaultStatus, isVaultReadyFor, lockVault, openWithVault, refreshLegacyPaymentRows, sealWithVault,
} from './vault';
import { fakeKekServer } from './vault-test-helper';

/** ADR-068: no shared browser-accessible key may decrypt another user's pending documents. */
const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };
const A2 = { userId: 'uA', companyId: 'c2' };
type S = typeof A;
const cur = { v: 1 };
const signIn = (s: S, down = false) => {
  setOfflineSession(s);
  resetPreparedSession();
  return bringUpVault(s, fakeKekServer(cur, { down })(s));
};
const SECRET = { customerName: 'Secret Customer LLC', total: '987654.32', note: 'tel +998901234567' };
const legacyStore = () => new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq']);
const legacyRow = (id: string, type: string, owner: S, seq: number) =>
  legacyStore().put({
    clientId: id, type, status: 'PENDING', createdAt: new Date().toISOString(), userId: owner.userId, companyId: owner.companyId, seq,
    payload: { clientId: id, ...SECRET }, schemaVersion: 1, attemptCount: 0,
  });
const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('hex');
const rawBlob = async (id: string) => hex((await db.queue.get(id))!._enc.ct);

/** Every byte persisted by the offline layer, as text (ciphertext as hex): what an attacker reading IndexedDB + localStorage sees. */
async function deviceDump(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of db.tables) {
    out[t.name] = (await t.toArray()).map((r) =>
      JSON.parse(JSON.stringify(r, (_k, v) => (v instanceof ArrayBuffer || v instanceof Uint8Array ? hex(v) : v))),
    );
  }
  out.localStorage = Object.fromEntries(Object.keys(window.localStorage).map((k) => [k, window.localStorage.getItem(k)]));
  return JSON.stringify(out);
}

describe('ADR-068 no shared key for pending documents', () => {
  beforeEach(async () => {
    cur.v = 1;
    lockVault();
    setOfflineSession(null);
    for (const t of db.tables) await t.clear();
    window.localStorage.clear();
    clearDeviceKey();
    await refreshLegacyPaymentRows(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('new order/visit/payment are written under the UK; no device key exists; no business data in IDB indexes or localStorage', async () => {
    await signIn(A);
    // reference cache row (customer) through the real repository store
    await offlineRepository.customers.bulkPut([{ id: 'cust-1', code: 'CODE-QQ', name: 'Secret Customer LLC', phone: null, priceListId: null, paymentTermDays: 0, isBlocked: false, cachedBalance: '5551234.00', isActive: true } as never]);
    const ids = [
      await queueRepository.enqueue('order', SECRET),
      await queueRepository.enqueue('visit', SECRET),
      await queueRepository.enqueue('payment', { amount: '987654.32', customerId: 'x' }),
    ];
    for (const id of ids) expect((await db.queue.get(id))!._enc.v).toBe('uk1');
    const dump = await deviceDump();
    for (const needle of ['Secret Customer', '987654', '5551234', '+998901234567', 'CODE-QQ']) expect(dump, needle).not.toContain(needle);
    const queueRowKeys = Object.keys((await db.queue.toArray())[0]!).sort();
    expect(queueRowKeys).toEqual(['_enc', 'clientId', 'companyId', 'createdAt', 'seq', 'status', 'type', 'userId']);
    expect(Object.keys((await db.customers.toArray())[0]!).sort()).toEqual(['_enc', 'id']);
  });

  it('vault not open (no network / KEK fetch fails): the save is blocked, nothing is stored, no device key fallback, the entered data stays with the caller', async () => {
    expect((await signIn(A, true)).status).toBe('unavailable');
    const form = { ...SECRET };
    for (const t of ['order', 'visit', 'payment'] as const) await expect(queueRepository.enqueue(t, form)).rejects.toBeInstanceOf(VaultUnavailableError);
    expect(await db.queue.count()).toBe(0);
    expect(window.localStorage.getItem('velto.dbKey')).toBeNull();
    expect(form).toEqual(SECRET); // untouched: the screen retries the same data
    // personal key obtained later (re-auth): the SAME pending save now succeeds
    expect((await signIn(A)).status).toBe('ready');
    const id = await queueRepository.enqueue('order', form);
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([id]);
  });

  it('A/B on the same device: B cannot list, open or push A\'s rows; B\'s own key fails to decrypt A\'s blob', async () => {
    await signIn(A);
    const id = await queueRepository.enqueue('order', SECRET);
    const blob = (await db.queue.get(id))!._enc;
    await signIn(B);
    expect(await queueRepository.listAll()).toEqual([]);
    expect(await queueRepository.listAllOwners()).toEqual([]);
    expect(await queueRepository.listPushable(20)).toEqual([]);
    expect(await openWithVault(A, id, blob)).toBeUndefined(); // vault is B's, not A's
    expect(await openWithVault(B, id, blob)).toBeUndefined(); // B's UK + B's AAD: auth-tag failure
    const own = await sealWithVault(B, id, SECRET);
    expect(own).not.toBeNull();
    expect(await openWithVault(A, id, own!)).toBeUndefined();
    expect(await db.queue.count()).toBe(1); // A's row still there, sealed
  });

  it.each([
    ['Telegram account switch', B],
    ['company switch', A2],
  ])('%s drops the previous UK from memory at once; the previous rows stay sealed and are restored on the owner\'s re-auth', async (_n, next) => {
    await signIn(A);
    const id = await queueRepository.enqueue('order', SECRET);
    setOfflineSession(next as S); // no logout in between
    expect(getVaultStatus()).toBe('locked');
    expect(isVaultReadyFor(A)).toBe(false);
    expect(await queueRepository.listAll()).toEqual([]);
    expect(await db.queue.get(id)).toBeDefined(); // never deleted
    await signIn(A);
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([id]);
  });

  it('session expiry / forced invalidation (401 on refresh): UK dropped, rows kept sealed, restored after re-auth', async () => {
    await signIn(A);
    const id = await queueRepository.enqueue('order', SECRET);
    const before = await rawBlob(id);
    setOfflineSession(null); // what the onUnauthorized handler does right after starting the seal
    expect((await endSessionSealing(A)).state).toBe('sealed');
    expect(getVaultStatus()).toBe('locked');
    expect(await rawBlob(id)).toBe(before);
    expect(await queueRepository.listAll()).toEqual([]);
    await signIn(A);
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([id]);
  });

  it('offline logout needs no network, drops the UK and keeps every row', async () => {
    await signIn(A);
    const id = await queueRepository.enqueue('order', SECRET);
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    await stopSyncAndWait();
    expect((await sealOwnerForLogout(A)).state).toBe('sealed');
    await wipeLocalAfterLogout();
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getVaultStatus()).toBe('locked');
    expect(await db.queue.get(id)).toBeDefined();
    expect(await db.vault.count()).toBe(1);
  });

  it('bring-up seals the owner\'s legacy device-key order/visit/payment rows and deletes velto.dbKey at once', async () => {
    await legacyRow('lo', 'order', A, 1);
    await legacyRow('lv', 'visit', A, 2);
    await legacyRow('lp', 'payment', A, 3);
    expect(window.localStorage.getItem('velto.dbKey')).not.toBeNull();
    const r = await signIn(A);
    expect(r).toMatchObject({ status: 'ready', deviceKeyDropped: true });
    expect(window.localStorage.getItem('velto.dbKey')).toBeNull();
    for (const id of ['lo', 'lv', 'lp']) expect((await db.queue.get(id))!._enc.v).toBe('uk1');
    expect((await queueRepository.listAll()).map((e) => e.clientId).sort()).toEqual(['lo', 'lp', 'lv']);
    const dump = await deviceDump();
    for (const needle of ['Secret Customer', '987654']) expect(dump).not.toContain(needle);
  });

  it('foreign legacy rows: counted not read; B is blocked (no new documents) and the device key stays; unblocked once the owner seals them', async () => {
    await legacyRow('a-leg', 'order', A, 1);
    const before = await rawBlob('a-leg');
    const r = await signIn(B);
    expect(r.deviceKeyDropped).toBeFalsy();
    expect(getForeignLegacyRows()).toBe(1);
    expect(await queueRepository.listAllOwners()).toEqual([]); // contents are never decrypted for B
    await expect(queueRepository.enqueue('order', { x: 1 })).rejects.toBeInstanceOf(ForeignLegacyBlockedError);
    expect(await rawBlob('a-leg')).toBe(before); // untouched, not deleted, not claimed
    expect(window.localStorage.getItem('velto.dbKey')).not.toBeNull();

    expect((await signIn(A)).deviceKeyDropped).toBe(true); // the owner signs in: sealed
    expect((await db.queue.get('a-leg'))!._enc.v).toBe('uk1');
    await signIn(B);
    expect(getForeignLegacyRows()).toBe(0);
    await expect(queueRepository.enqueue('order', { x: 1 })).resolves.toBeTruthy();
  });

  it('ownerless legacy row: A and B are both gated (no new documents), nothing decrypted/exported/pushed, row preserved byte-for-byte, device key kept', async () => {
    await legacyStore().put({
      clientId: 'nobody', type: 'order', status: 'PENDING', createdAt: new Date().toISOString(), seq: 1,
      payload: { clientId: 'nobody', agentId: A.userId, ...SECRET }, schemaVersion: 1, attemptCount: 0,
    });
    const before = await rawBlob('nobody');
    for (const u of [A, B]) {
      const r = await signIn(u);
      expect(r.deviceKeyDropped).toBeFalsy();
      expect(getForeignLegacyRows()).toBe(1);
      expect(await queueRepository.listAllOwners()).toEqual([]);
      expect(JSON.parse(await queueRepository.exportPendingToJson()).items).toEqual([]);
      expect(await queueRepository.listPushable(20)).toEqual([]);
      await expect(queueRepository.enqueue('order', { x: 1 })).rejects.toBeInstanceOf(ForeignLegacyBlockedError);
      expect(await rawBlob('nobody')).toBe(before);
    }
    expect(window.localStorage.getItem('velto.dbKey')).not.toBeNull();
  });
});
