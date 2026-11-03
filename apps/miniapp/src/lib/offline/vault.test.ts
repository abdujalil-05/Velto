import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pushSync = vi.fn();
vi.mock('@/lib/api/sync', () => ({ pullSync: vi.fn(), pushSync: (...a: unknown[]) => pushSync(...a) }));

import { clearDeviceKey, encryptValue, hasDeviceKey } from './crypto';
import { clearOfflineDb, db } from './db';
import { EncryptedStore } from './encrypted-store';
import { bringUpVault, bringUpVaultWithRetry, sealOwnerForLogout, wipeLocalAfterLogout } from './held-seal';
import { endSessionSealing } from './session-end';
import { handleSessionRevoked } from './revoke-wipe';
import { OfflineKekRetiredError } from '@/lib/api/offline-kek';
import { queueRepository } from './queue';
import { setOfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';
import { resumeSync, runPush, stopSyncAndWait } from './sync-engine-core';
import { VaultUnavailableError as VUE } from './vault';
import { VaultUnavailableError, getVaultStatus, isVaultReadyFor, lockVault, openWithVault } from './vault';
import { fakeKekServer } from './vault-test-helper';

const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };
const A2 = { userId: 'uA', companyId: 'c2' };
const HOLD = 'PAYMENT_IDEMPOTENCY_CONFLICT';
const cur = { v: 1 };
type S = typeof A;

const as = (s: S) => {
  setOfflineSession(s);
  resetPreparedSession();
};
const up = (s: S, opts: Parameters<typeof fakeKekServer>[1] = {}) => bringUpVault(s, fakeKekServer(cur, opts)(s));

let lastRemainingPayments = -1;

/** Everything this logout path does, with no KEK getter available at all. */
async function logoutOffline(s: S) {
  await stopSyncAndWait();
  const { state, remainingPayments } = await sealOwnerForLogout(s);
  await wipeLocalAfterLogout();
  setOfflineSession(null);
  lastRemainingPayments = remainingPayments;
  return state;
}

async function heldPayment(): Promise<string> {
  const id = await queueRepository.enqueue('payment', { amount: '123.45', customerId: 'cust-secret-1' });
  await queueRepository.markConflict(id, { code: HOLD, message: 'x' });
  return id;
}

/** Every byte a thief of the device would have: all IndexedDB tables + localStorage. */
async function deviceMaterial() {
  const bin = (v: unknown): string => {
    if (v instanceof ArrayBuffer) return Buffer.from(v).toString('latin1');
    if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1');
    if (Array.isArray(v)) return v.map(bin).join('|');
    if (v && typeof v === 'object') return Object.values(v).map(bin).join('|');
    return String(v);
  };
  const tables = await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()] as const));
  const ls = Object.fromEntries(Object.keys(window.localStorage).map((k) => [k, window.localStorage.getItem(k)!]));
  return { tables: Object.fromEntries(tables), ls, dump: bin(tables) + bin(ls) };
}

/** Tries every 32-byte value found on the device (localStorage) plus extra candidate keys against every wrapped UK and every vault row. */
async function canAnyDeviceMaterialOpen(victim: S, extraKeks: Uint8Array[]): Promise<boolean> {
  const { tables, ls } = await deviceMaterial();
  const cands: Uint8Array[] = [...extraKeks];
  for (const v of Object.values(ls)) {
    try {
      const b = Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
      if (b.length === 32) cands.push(b);
    } catch {
      /* not base64 */
    }
  }
  for (const k of cands) {
    for (const w of ((tables.vault ?? []) as { userId: string; companyId: string; wrappedUK: ArrayBuffer }[]).filter((r) => r.userId === victim.userId && r.companyId === victim.companyId)) {
      try {
        const kek = await crypto.subtle.importKey('raw', k as BufferSource, 'AES-KW', false, ['unwrapKey']);
        await crypto.subtle.unwrapKey('raw', w.wrappedUK, kek, 'AES-KW', 'AES-GCM', false, ['decrypt']);
        return true;
      } catch {
        /* cannot open */
      }
    }
    const key = await crypto.subtle.importKey('raw', k as BufferSource, 'AES-GCM', false, ['decrypt']);
    for (const r of ((tables.queue ?? []) as { userId: string; companyId: string; _enc: { iv: Uint8Array; ct: ArrayBuffer; v?: string } }[]).filter((x) => x.userId === victim.userId && x.companyId === victim.companyId)) {
      if (r._enc.v !== 'uk1') continue;
      try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r._enc.iv as BufferSource }, key, r._enc.ct);
        return true;
      } catch {
        /* cannot open */
      }
    }
  }
  return false;
}

describe('vault key (UK) for payments', () => {
  beforeEach(async () => {
    cur.v = 1;
    pushSync.mockReset();
    lockVault();
    as(A);
    await db.queue.clear();
    await db.vault.clear();
    await db.sealed.clear();
    await db.meta.clear();
    window.localStorage.clear();
    clearDeviceKey(); // also resets the in-memory cached device key
  });
  afterEach(() => resumeSync());

  it('creating ANY document (payment, order, visit) is blocked when the KEK is unavailable: nothing is written, no device key is created', async () => {
    expect((await up(A, { down: true })).status).toBe('unavailable');
    for (const t of ['payment', 'order', 'visit'] as const) {
      await expect(queueRepository.enqueue(t, { x: 1 })).rejects.toBeInstanceOf(VaultUnavailableError);
    }
    expect(await db.queue.count()).toBe(0);
    expect(window.localStorage.getItem('velto.dbKey')).toBeNull();
  });

  it('conflict online -> offline -> logout completes with no network -> other user/company cannot open it -> owner re-login restores', async () => {
    expect((await up(A)).status).toBe('ready');
    const id = await heldPayment();
    await queueRepository.enqueue('order', { customerId: 'cust-secret-2' }); // device-key row of the owner: must move too
    expect(window.localStorage.getItem('velto.dbKey')).toBeNull(); // the order went straight under the UK: no device key exists

    expect(await canAnyDeviceMaterialOpen(A, [(await fakeKekServer(cur)(A)()).bytes])).toBe(true); // positive control: the owner's KEK does open it
    expect(await logoutOffline(A)).toBe('sealed'); // no getKek anywhere in this path
    expect(getVaultStatus()).toBe('locked');
    expect(window.localStorage.getItem('velto.dbKey')).toBeNull(); // no device-key rows left -> key dropped
    expect(await db.queue.count()).toBe(2); // held row + order kept, nothing deleted

    // plaintext metadata only: no amount / customer anywhere on the device
    const { dump, tables } = await deviceMaterial();
    for (const needle of ['123.45', 'cust-secret-1', 'cust-secret-2']) expect(dump).not.toContain(needle);
    expect(Object.keys((tables.queue as object[])[0]!).sort()).toEqual(['_enc', 'clientId', 'companyId', 'createdAt', 'seq', 'status', 'type', 'userId'].sort());
    expect(Object.keys((tables.vault as object[])[0]!).sort()).toEqual(['companyId', 'kekVersion', 'userId', 'wrappedUK']);

    // other user, same company; and same user, other company: own vault, nothing of A's visible or pushable
    for (const other of [B, A2]) {
      as(other);
      expect((await up(other)).status).toBe('ready');
      expect(await queueRepository.listAllOwners()).toEqual([]);
      expect(await queueRepository.listAll()).toEqual([]);
      expect(await queueRepository.listHeld()).toEqual([]);
      expect(await queueRepository.listPushable(20)).toEqual([]);
      const raw = (await db.queue.get(id))!;
      expect(await openWithVault(A, id, raw._enc)).toBeUndefined(); // not ready for A
      expect(await openWithVault(other, id, raw._enc)).toBeUndefined(); // other's UK + other's AAD
      // attacker holds the device AND its own KEK: still cannot open A's wrapped UK / rows
      expect(await canAnyDeviceMaterialOpen(A, [(await fakeKekServer(cur)(other)()).bytes])).toBe(false);
      await logoutOffline(other);
    }
    pushSync.mockResolvedValue({ results: [] });
    as(B);
    await up(B);
    await runPush();
    expect(pushSync).not.toHaveBeenCalled();
    await logoutOffline(B);

    // owner signs in again: both rows come back
    as(A);
    await up(A);
    expect((await queueRepository.listHeld()).map((e) => e.clientId)).toEqual([id]);
    expect((await queueRepository.listHeld())[0]).toMatchObject({ status: 'CONFLICT', payload: { amount: '123.45' } });
    expect(await queueRepository.listAll()).toHaveLength(2);
  });

  it('restart (fresh module state) keeps rows locked until authenticated online; API down keeps them locked; then restore', async () => {
    await up(A);
    const id = await heldPayment();
    await logoutOffline(A);

    vi.resetModules();
    const q = await import('./queue');
    const s = await import('./session');
    const hs = await import('./held-seal');
    const v = await import('./vault');
    const h = await import('./vault-test-helper');
    s.setOfflineSession(A); // e.g. persisted owner hint after reload; no UK in memory
    expect(v.getVaultStatus()).toBe('locked');
    expect(await q.queueRepository.listAllOwners()).toEqual([]); // locked, not deleted
    expect((await hs.bringUpVault(A, h.fakeKekServer(cur, { down: true })(A))).status).toBe('unavailable');
    expect(await q.queueRepository.listAll()).toEqual([]);
    await expect(q.queueRepository.enqueue('payment', {})).rejects.toBeInstanceOf(v.VaultUnavailableError);
    expect((await hs.bringUpVault(A, h.fakeKekServer(cur)(A))).status).toBe('ready');
    expect((await q.queueRepository.listHeld()).map((e) => e.clientId)).toEqual([id]);
  });

  it('KEK rotation v1 -> v2 rewraps the UK; rows stay readable; the old KEK no longer opens the new wrap', async () => {
    await up(A);
    const id = await heldPayment();
    const before = (await db.vault.get([A.userId, A.companyId]))!;
    expect(before.kekVersion).toBe(1);
    lockVault();
    cur.v = 2;
    const asked: (number | undefined)[] = [];
    const base = fakeKekServer(cur)(A);
    const res = await bringUpVault(A, async (v) => {
      asked.push(v);
      return base(v);
    });
    expect(res.status).toBe('ready');
    expect(asked).toEqual([undefined, 1]); // current, then ?version=stored
    const after = (await db.vault.get([A.userId, A.companyId]))!;
    expect(after.kekVersion).toBe(2);
    expect(Buffer.from(after.wrappedUK).equals(Buffer.from(before.wrappedUK))).toBe(false);
    expect((await queueRepository.listHeld()).map((e) => e.clientId)).toEqual([id]); // same UK, rows untouched
    expect(await canAnyDeviceMaterialOpen(A, [(await fakeKekServer(cur)(A)(1)).bytes])).toBe(false); // retired v1 KEK vs v2 wrap
  });

  it('410 (stored KEK version retired): rows stay locked, nothing deleted, status retired; later recovery path is not destroyed', async () => {
    await up(A);
    const id = await heldPayment();
    lockVault();
    cur.v = 2;
    expect((await up(A, { retired: [1] })).status).toBe('retired');
    expect(getVaultStatus()).toBe('retired');
    expect(await queueRepository.listAll()).toEqual([]);
    expect(await db.queue.get(id)).toBeDefined();
    expect((await db.vault.get([A.userId, A.companyId]))!.kekVersion).toBe(1); // untouched
    await expect(queueRepository.enqueue('payment', {})).rejects.toBeInstanceOf(VaultUnavailableError);
  });

  it('legacy device-key held/payment rows move to the vault on the owner next online login', async () => {
    // pre-vault device: payment written under the device key
    const legacy = new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq']);
    await legacy.put({
      clientId: 'leg-1', type: 'payment', status: 'FAILED', createdAt: new Date().toISOString(), userId: A.userId, companyId: A.companyId, seq: 1,
      payload: { amount: '55.00' }, schemaVersion: 1, attemptCount: 1, lastError: { code: HOLD, message: 'x' },
    });
    expect((await db.queue.get('leg-1'))!._enc.v).toBeUndefined();
    await up(A);
    expect((await db.queue.get('leg-1'))!._enc.v).toBe('uk1');
    expect((await queueRepository.listHeld()).map((e) => e.clientId)).toEqual(['leg-1']);
  });

  it('logout awaits an in-flight push before touching the queue; held rows are never re-pushed', async () => {
    await up(A);
    const held = await heldPayment();
    const order = await queueRepository.enqueue('order', { outletId: 'o1' });
    let release!: (v: unknown) => void;
    pushSync.mockImplementation(() => new Promise((r) => (release = r)));
    const pushing = runPush();
    await vi.waitFor(() => expect(pushSync).toHaveBeenCalledTimes(1));
    expect(pushSync.mock.calls[0]![0].map((i: { clientId: string }) => i.clientId)).toEqual([order]); // held row not in the batch

    let stopped = false;
    const logout = stopSyncAndWait().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // still waiting for the in-flight push
    release({ results: [{ clientId: order, status: 'ACCEPTED', serverId: 's1' }] });
    await pushing;
    await logout;
    expect(stopped).toBe(true);
    expect((await queueRepository.listAll()).find((e) => e.clientId === order)?.status).toBe('SYNCED'); // ACK applied before logout proceeded

    await sealOwnerForLogout(A);
    await wipeLocalAfterLogout();
    setOfflineSession(null);
    as(A);
    pushSync.mockReset();
    pushSync.mockResolvedValue({ results: [] });
    await up(A);
    await runPush();
    const sent = pushSync.mock.calls.flatMap((c) => c[0].map((i: { clientId: string }) => i.clientId));
    expect(sent).not.toContain(held);
    expect((await queueRepository.listHeld())[0]?.clientId).toBe(held);
  });

  it('logout keeps the device key while a device-key row remains (vault was never ready) and reports pending', async () => {
    const legacy = new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq']);
    await legacy.put({ clientId: 'leg-2', type: 'payment', status: 'FAILED', createdAt: new Date().toISOString(), userId: A.userId, companyId: A.companyId, seq: 1, payload: {}, schemaVersion: 1, attemptCount: 1, lastError: { code: HOLD, message: 'x' } });
    expect(window.localStorage.getItem('velto.dbKey')).not.toBeNull();
    expect(await logoutOffline(A)).toBe('pending');
    expect(lastRemainingPayments).toBe(1); // reported explicitly, never a silent success
    expect(window.localStorage.getItem('velto.dbKey')).not.toBeNull(); // dropping it would destroy the row
    expect(await db.queue.get('leg-2')).toBeDefined();
  });

  it('clearOfflineDb never touches the wrapped keys', async () => {
    await up(A);
    await clearOfflineDb({ keepQueue: true });
    expect(await db.vault.count()).toBe(1);
  });

  const legacyPayment = (id: string, over: Record<string, unknown> = {}) =>
    new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq']).put({
      clientId: id, type: 'payment', status: 'PENDING', createdAt: new Date().toISOString(), userId: A.userId, companyId: A.companyId, seq: 1,
      payload: { amount: '77.00', customerId: 'cust-legacy' }, schemaVersion: 1, attemptCount: 0, ...over,
    });

  it('[1] hung push: logout wait is capped, the request was aborted, a late completion cannot write PAYMENT data', async () => {
    await up(A);
    const pay = await queueRepository.enqueue('payment', { amount: '9.00' });
    let signal: AbortSignal | undefined;
    let release!: (v: unknown) => void;
    pushSync.mockImplementation((_d: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise((r) => (release = r)); // ignores the abort: a truly hung request
    });
    const pushing = runPush();
    await vi.waitFor(() => expect(pushSync).toHaveBeenCalledTimes(1));
    const t0 = Date.now();
    await stopSyncAndWait(50);
    expect(Date.now() - t0).toBeLessThan(1000); // did not hang
    expect(signal?.aborted).toBe(true);
    await sealOwnerForLogout(A);
    await wipeLocalAfterLogout(); // vault locked
    const raw = (await db.queue.get(pay))!;
    release({ results: [{ clientId: pay, status: 'ACCEPTED', serverId: 's9' }] }); // late completion
    await pushing.catch(() => {});
    const after = (await db.queue.get(pay))!;
    expect(after._enc.v).toBe('uk1'); // still vault format, never a device-key payment row
    expect(Buffer.from(after._enc.ct).equals(Buffer.from(raw._enc.ct))).toBe(true); // untouched
    expect(after.status).toBe(raw.status);
  });

  it('[1][2] aborted push: attempt not counted; the SAME clientId is re-sent and server idempotency makes it safe (one creation)', async () => {
    await up(A);
    const pay = await queueRepository.enqueue('payment', { amount: '9.00' });
    const created = new Set<string>();
    const server = (docs: { clientId: string }[]) => ({
      results: docs.map((d) => {
        const dup = created.has(d.clientId);
        created.add(d.clientId);
        return { clientId: d.clientId, status: dup ? 'DUPLICATE' : 'ACCEPTED', serverId: 'srv-1' };
      }),
    });
    pushSync.mockImplementationOnce((docs: { clientId: string }[], s?: AbortSignal) => {
      server(docs); // server processed it ...
      return new Promise((_r, rej) => s?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))); // ... client never saw the ACK
    });
    const pushing = runPush();
    await vi.waitFor(() => expect(pushSync).toHaveBeenCalledTimes(1));
    await stopSyncAndWait(1000);
    await pushing;
    const e = (await queueRepository.listAll()).find((x) => x.clientId === pay)!;
    expect(e).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    resumeSync();
    pushSync.mockImplementation(async (docs: { clientId: string }[]) => server(docs));
    await runPush();
    expect(pushSync.mock.calls[1]![0][0].clientId).toBe(pay);
    expect(created.size).toBe(1); // server-side: one payment
    expect((await queueRepository.listAll()).find((x) => x.clientId === pay)?.status).toBe('SYNCED');
  });

  it('[2] fail closed: a PAYMENT write without a ready vault throws and leaves the row untouched (no device-key fallback)', async () => {
    await legacyPayment('leg-fc', { status: 'FAILED', lastError: { code: HOLD, message: 'x' } });
    const before = (await db.queue.get('leg-fc'))!;
    expect(getVaultStatus()).toBe('locked'); // vault never came up this session
    await expect(queueRepository.markFailed('leg-fc', { code: 'X', message: 'y' })).rejects.toBeInstanceOf(VUE);
    const after = (await db.queue.get('leg-fc'))!;
    expect(after._enc.v).toBeUndefined();
    expect(Buffer.from(after._enc.ct).equals(Buffer.from(before._enc.ct))).toBe(true);
    expect(await queueRepository.listPushable(20)).toEqual([]); // legacy payment is not pushed while the vault is down
  });

  it('[2] session end (token expiry) seals non-payment rows too, then locks; revoke does the same sequence', async () => {
    await up(A);
    const order = await queueRepository.enqueue('order', { customerId: 'cust-o' });
    const pay = await heldPayment();
    expect((await db.queue.get(order))!._enc.v).toBe('uk1'); // new documents are sealed at write time
    const r = await endSessionSealing(A);
    expect(r).toMatchObject({ state: "sealed", remainingPayments: 0 });
    expect(getVaultStatus()).toBe('locked');
    expect((await db.queue.get(order))!._enc.v).toBe('uk1');
    expect((await db.queue.get(pay))!._enc.v).toBe('uk1');

    // revoke path
    as(A);
    await up(A);
    const order2 = await queueRepository.enqueue('order', { customerId: 'cust-o2' });
    await handleSessionRevoked();
    expect(getVaultStatus()).toBe('locked');
    expect((await db.queue.get(order2))!._enc.v).toBe('uk1');
    expect((await db.queue.get(pay))!._enc.v).toBe('uk1');
    expect(await db.queue.count()).toBe(3); // nothing deleted
  });

  it('[3] CAS: a row ACK-deleted while being sealed is not resurrected', async () => {
    await legacyPayment('leg-del');
    await up(A); // migration may already run; recreate a device-key row after
    await db.queue.delete('leg-del');
    await legacyPayment('leg-del2');
    const orig = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...a: Parameters<typeof orig>) => {
      await db.queue.delete('leg-del2'); // ACK-delete between read and commit
      return orig(...a);
    });
    const res = await queueRepository.sealOwnRowsToVault(A);
    spy.mockRestore();
    expect(await db.queue.get('leg-del2')).toBeUndefined();
    expect(res.remaining).toBe(0);
  });

  it('[3] CAS: a row changed while being sealed is not overwritten with the stale copy (held row not revived)', async () => {
    await up(A);
    await legacyPayment('leg-cas', { status: 'CONFLICT', lastError: { code: HOLD, message: 'x' } });
    const orig = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...a: Parameters<typeof orig>) => {
      // concurrent legitimate update (e.g. server-confirmed outcome applied) between our read and commit
      await legacyPayment('leg-cas', { status: 'SYNCED', serverId: 'srv-9' });
      return orig(...a);
    });
    const res = await queueRepository.sealOwnRowsToVault(A);
    spy.mockRestore();
    expect(res.moved).toBe(1); // second pass re-read the new value and sealed it
    const e = (await queueRepository.listAll()).find((x) => x.clientId === 'leg-cas')!;
    expect(e).toMatchObject({ status: 'SYNCED', serverId: 'srv-9' }); // never reverted to the stale CONFLICT
    expect((await db.queue.get('leg-cas'))!._enc.v).toBe('uk1');
  });

  it('[4] bring-up retries with backoff while online-but-failing and then migrates legacy device-key payments; 410 is not retried', async () => {
    await legacyPayment('leg-r1', { status: 'FAILED', lastError: { code: HOLD, message: 'x' } });
    const ok = fakeKekServer(cur)(A);
    let calls = 0;
    const flaky = async (v?: number) => {
      calls += 1;
      if (calls <= 2) throw new Error('503');
      return ok(v);
    };
    const slept: number[] = [];
    const res = await bringUpVaultWithRetry(A, { getKek: flaky, delaysMs: [5, 10, 20], sleep: async (ms) => void slept.push(ms) });
    expect(res.status).toBe('ready');
    expect(slept).toEqual([5, 10]);
    expect((await db.queue.get('leg-r1'))!._enc.v).toBe('uk1');

    lockVault();
    await db.vault.clear();
    let n410 = 0;
    const retired = await bringUpVaultWithRetry(A, { getKek: async () => { n410 += 1; throw new OfflineKekRetiredError(); }, delaysMs: [1, 1], sleep: async () => {} });
    expect(retired.status).toBe('retired');
    expect(n410).toBe(1);
  });

  it('session expiry wipes the reference cache and drops the device key; vault rows stay intact and recoverable after owner re-auth', async () => {
    await up(A);
    const pay = await heldPayment();
    await db.customers.put({ id: 'c-a', code: 'A', name: 'A-secret', _enc: await encryptValue({ n: 'A-secret' }) } as never); // creates the device key like a cache pull
    expect(hasDeviceKey()).toBe(true);
    await endSessionSealing(A);
    setOfflineSession(null);
    expect(await db.customers.count()).toBe(0);
    expect(hasDeviceKey()).toBe(false);
    expect(await db.queue.get(pay)).toBeDefined();
    as(A);
    await up(A);
    expect((await queueRepository.listHeld()).map((e) => e.clientId)).toEqual([pay]);
  });

  it('device key is dropped at bring-up even when nothing was moved (no device-key rows left)', async () => {
    await up(A);
    await queueRepository.enqueue('order', { customerId: 'cust-o' });
    await up(A);
    expect(hasDeviceKey()).toBe(false);
  });

  it('[5] ownerless payment (even naming A in its payload) is never exported, listed or decrypted; row is kept', async () => {
    await up(A);
    await queueRepository.enqueue('order', { x: 1 });
    await legacyPayment('leg-q', { userId: undefined, companyId: undefined, payload: { amount: '88.00', customerId: 'cust-q', userId: A.userId } });
    const out = JSON.stringify(JSON.parse(await queueRepository.exportPendingToJson()));
    expect(out).not.toContain('leg-q');
    expect(out).not.toContain('88.00');
    expect((await queueRepository.listAll()).some((e) => e.clientId === 'leg-q')).toBe(false);
    expect(await db.queue.get('leg-q')).toBeDefined();
  });

  it('late session end of A (user B logged in meanwhile) does not lock B vault', async () => {
    await up(A);
    lockVault(); // A's session ended; B signs in before A's deferred seal/lock completes
    as(B);
    expect((await up(B)).status).toBe('ready');
    await endSessionSealing(A);
    expect(getVaultStatus()).toBe('ready');
    expect(isVaultReadyFor(B)).toBe(true);
  });

  it('an ownerless row naming A as creator is never claimed or re-encrypted by bring-up; stays under the device key, preserved', async () => {
    const legacy = new EncryptedStore<Record<string, unknown>, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq']);
    await legacy.put({
      clientId: 'own-less', type: 'payment', status: 'PENDING', createdAt: new Date().toISOString(), seq: 1,
      payload: { amount: '9.00', agentId: A.userId }, schemaVersion: 1, attemptCount: 0,
    });
    await up(A);
    const row = (await db.queue.get('own-less'))!;
    expect(row._enc.v).toBeUndefined();
    expect(row.userId).toBeUndefined();
    expect(await queueRepository.listPushable(20)).toEqual([]);
  });
});
