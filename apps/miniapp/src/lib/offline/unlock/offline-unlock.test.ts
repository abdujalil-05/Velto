import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { queueRepository } from '../queue';
import { getOfflineSession, isSyncPaused, setOfflineSession } from '../session';
import { getVaultStatus, isVaultReadyFor, lockVault, ensureVault } from '../vault';
import { fakeKekServer, readyVault } from '../vault-test-helper';
import { getLocalOwner, isLocalMode, leaveLocalMode, LocalModeNetworkError } from '../local-mode';
import { emergencyWipe } from '../held-seal';
import { handleSessionRevoked } from '../revoke-wipe';
import { apiFetch, onUnauthorized } from '@/lib/api/client';
import { fetchOfflineKek } from '@/lib/api/offline-kek';
import { setTokens } from '@/lib/auth/tokens';
import { argon2Derive } from './kdf-core';
import { FLOOR_PARAMS, TARGET_PARAMS } from './kdf';
import { missingCapabilities } from './capabilities';
import { validatePassphrase } from './policy';
import { withVerificationProbe } from '../local-mode';
import { reconnectFromLocal } from './reconnect';
import { MAX_FAILURES, UNLOCK_TTL_MS, deleteEntry, enrollOfflineUnlock, hasEntry, touchOnline, unlockOffline, changePassphrase, type UnlockDeps } from './entry';
import { guardTokenOwner } from '../sync-engine-core';

const A = { userId: 'uA', companyId: 'c1' };
const B = { userId: 'uB', companyId: 'c1' };
const userA = { id: 'uA', companyId: 'c1', firstName: 'Anvar', lastName: 'Karimov', roles: ['agent'], permissions: ['orders.create'] };
const PHRASE = 'Blue-Falcon-Lamp-42';
const enc = (s: string) => new TextEncoder().encode(s);
const jwt = (o: { userId: string; companyId: string }) => {
  const e = (v: unknown) => btoa(JSON.stringify(v)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${e({ alg: 'HS256' })}.${e({ sub: o.userId, companyId: o.companyId })}.sig`;
};

let clock = 1_000_000;
const seen: unknown[] = [];
/** Real Argon2id, tiny cost so the suite stays fast; records the params the production code asked for. */
function mkDeps(session = A, opts: { failTarget?: boolean; kdfBroken?: boolean } = {}): UnlockDeps {
  return {
    now: () => clock,
    getKek: fakeKekServer()(session),
    derive: async (pass, salt, params, secret) => {
      seen.push(params);
      if (opts.kdfBroken) throw new Error('KDF_FAILED');
      if (opts.failTarget && params.m === TARGET_PARAMS.m) throw new RangeError('oom');
      return argon2Derive(enc(pass), salt, enc(secret), { m: 256, t: 1, p: 1, v: 19 });
    },
  };
}

async function reset() {
  leaveLocalMode();
  lockVault();
  await db.queue.clear();
  await db.vault.clear();
  await db.offlineUnlock.clear();
  await db.meta.clear();
  seen.length = 0;
  clock = 1_000_000;
  setOfflineSession(null);
  vi.stubGlobal('Worker', class {});
}
async function enrollA(pass = PHRASE) {
  await readyVault(A);
  setOfflineSession(A);
  const r = await enrollOfflineUnlock(A, userA, pass, pass, {}, mkDeps());
  expect(r.kind).toBe('ok');
}
async function patchRow(p: object) {
  const r = (await db.offlineUnlock.get([A.userId, A.companyId]))!;
  await db.offlineUnlock.put({ ...r, ...p });
}
async function goOffline() {
  leaveLocalMode();
  lockVault();
  setOfflineSession(null);
}

describe('Offline Unlock (ADR-071)', () => {
  beforeEach(reset);

  it('policy: weak passphrases rejected, strong accepted', () => {
    expect(validatePassphrase('short1')).toContain('tooShort');
    expect(validatePassphrase('123456789012')).toContain('allDigits');
    expect(validatePassphrase('abcxxxxxxxxxxx')).toEqual(expect.arrayContaining(['sequentialRun', 'repeatedRun']));
    expect(validatePassphrase('myAnvar-secret-77', { firstName: 'Anvar' })).toContain('containsName');
    expect(validatePassphrase('x-998901234567-y-zq', { phone: '+998 90 123 45 67' })).toContain('containsPhone');
    expect(validatePassphrase('my-password-Zk9!q')).toContain('denylisted');
    expect(validatePassphrase(PHRASE, {}, 'other')).toContain('mismatch');
    expect(validatePassphrase(PHRASE, { firstName: 'Anvar' }, PHRASE)).toEqual([]);
  });

  it('enroll rejects a weak passphrase and stores nothing', async () => {
    await readyVault(A);
    const r = await enrollOfflineUnlock(A, userA, 'password1234', 'password1234', {}, mkDeps());
    expect(r.kind).toBe('weak');
    expect(await hasEntry(A)).toBe(false);
  });

  it('round trip: enroll online, go offline, unlock -> own vault rows readable, local mode, session = owner', async () => {
    await readyVault(A);
    setOfflineSession(A);
    const id = await queueRepository.enqueue('payment', { amount: '100.00', customerId: 'c' });
    expect((await enrollOfflineUnlock(A, userA, PHRASE, PHRASE, {}, mkDeps())).kind).toBe('ok');
    await goOffline();
    expect(getVaultStatus()).toBe('locked');
    const res = await unlockOffline(A, PHRASE, mkDeps());
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.user.id).toBe('uA');
    expect(isLocalMode()).toBe(true);
    expect(getOfflineSession()).toEqual(A);
    expect(isVaultReadyFor(A)).toBe(true);
    expect((await queueRepository.listAll()).some((e) => e.clientId === id)).toBe(true);
  });

  it('stored record holds no passphrase, derived key or raw UK; params are stored per entry', async () => {
    await enrollA();
    const row = (await db.offlineUnlock.get([A.userId, A.companyId]))!;
    expect(Object.keys(row).sort()).toEqual(['companyId', 'enrolledAt', 'failCount', 'fmt', 'kekVersion', 'lastOnlineAt', 'nextAttemptAt', 'params', 'profile', 'salt', 'userId', 'wrappedUK'].sort());
    expect(row.fmt).toBe('pw1');
    expect(row.wrappedUK.byteLength).toBe(40); // AES-KW(32-byte UK) = 40 bytes, i.e. not the raw key
    expect(row.salt.byteLength).toBe(16);
    expect(row.params).toEqual(TARGET_PARAMS);
    const text = JSON.stringify(row, (_k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? Array.from(new Uint8Array(v as ArrayBuffer)) : v));
    expect(text).not.toContain(PHRASE);
    const derived = await argon2Derive(enc(PHRASE), new Uint8Array(row.salt), enc(`${A.companyId}|${A.userId}`), { m: 256, t: 1, p: 1, v: 19 });
    expect(text).not.toContain(JSON.stringify(Array.from(derived)));
  });

  it('floor parameters are used and stored when the device cannot do the target', async () => {
    await readyVault(A);
    const r = await enrollOfflineUnlock(A, userA, PHRASE, PHRASE, {}, mkDeps(A, { failTarget: true }));
    expect(r).toEqual({ kind: 'ok', params: FLOOR_PARAMS });
    expect((await db.offlineUnlock.get([A.userId, A.companyId]))!.params).toEqual(FLOOR_PARAMS);
  });

  it('wrong passphrase: AES-KW failure, counter + exponential backoff, entry deleted at 10 failures', async () => {
    await enrollA();
    await goOffline();
    const r1 = await unlockOffline(A, 'Wrong-Horse-Battery-9', mkDeps());
    expect(r1).toEqual({ kind: 'wrong', remaining: MAX_FAILURES - 1 });
    expect(isLocalMode()).toBe(false);
    const again = await unlockOffline(A, PHRASE, mkDeps());
    expect(again.kind).toBe('backoff'); // even the right one waits out the delay
    clock += 3_000;
    expect((await unlockOffline(A, 'Wrong-Horse-Battery-9', mkDeps())).kind).toBe('wrong');
    expect((await db.offlineUnlock.get([A.userId, A.companyId]))!.failCount).toBe(2);
    for (let i = 3; i < MAX_FAILURES; i++) {
      clock += 60 * 60_000;
      await patchRow({ lastOnlineAt: clock });
      expect((await unlockOffline(A, 'Wrong-Horse-Battery-9', mkDeps())).kind).toBe('wrong');
    }
    clock += 60 * 60_000;
    await patchRow({ lastOnlineAt: clock });
    expect((await unlockOffline(A, 'Wrong-Horse-Battery-9', mkDeps())).kind).toBe('wiped');
    expect(await hasEntry(A)).toBe(false);
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('no-entry');
  });

  it("B cannot open A's entry, even with a copied record and A's passphrase (wrap is bound to the owner)", async () => {
    await enrollA();
    await goOffline();
    expect((await unlockOffline(B, PHRASE, mkDeps(B))).kind).toBe('no-entry');
    const row = (await db.offlineUnlock.get([A.userId, A.companyId]))!;
    await db.offlineUnlock.put({ ...row, userId: B.userId, companyId: B.companyId });
    expect((await unlockOffline(B, PHRASE, mkDeps(B))).kind).toBe('wrong');
    expect(isLocalMode()).toBe(false);
    expect(isVaultReadyFor(B)).toBe(false);
  });

  it('KEK rotation keeps the entry usable (passphrase wrap is independent of the server KEK)', async () => {
    await enrollA();
    await goOffline();
    const cur = { v: 2 };
    expect(await ensureVault(A, fakeKekServer(cur)(A))).toBe('ready'); // rewrap v1 -> v2
    expect(await hasEntry(A)).toBe(true);
    await goOffline();
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('ok');
  });

  it('entry is deleted on retired KEK, explicit logout (deleteEntry), revoke and emergency wipe', async () => {
    await enrollA();
    lockVault();
    expect(await ensureVault(A, fakeKekServer({ v: 2 }, { retired: [1] })(A))).toBe('retired');
    expect(await hasEntry(A)).toBe(false);

    await enrollA();
    await deleteEntry(A);
    expect(await hasEntry(A)).toBe(false);

    await enrollA();
    setOfflineSession(A);
    await handleSessionRevoked();
    expect(await hasEntry(A)).toBe(false);

    await db.offlineUnlock.clear();
    await readyVault(A);
    setOfflineSession(A);
    expect((await enrollOfflineUnlock(A, userA, PHRASE, PHRASE, {}, mkDeps())).kind).toBe('ok');
    await emergencyWipe();
    expect(await hasEntry(A)).toBe(false);
  });

  it('expiry keeps the entry; TTL > 72 h and clock rollback refuse unlock; online contact moves the anchor', async () => {
    await enrollA();
    await goOffline();
    clock += UNLOCK_TTL_MS + 1;
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('expired');
    expect(await hasEntry(A)).toBe(true);
    clock = 1_000_000 - 1; // device clock behind the last online contact
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('expired');
    clock = 1_000_000 + UNLOCK_TTL_MS + 5_000;
    await readyVault(A);
    await touchOnline(A, userA, clock);
    await goOffline();
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('ok');
  });

  it('local mode: zero fetches, sync paused, KEK/refresh refused; orders/visits/payments queue PENDING under the entry owner', async () => {
    await enrollA();
    await goOffline();
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    setTokens(jwt(A), 'rA');
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('ok');
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(LocalModeNetworkError);
    await expect(fetchOfflineKek()).rejects.toBeInstanceOf(LocalModeNetworkError);
    expect(isSyncPaused()).toBe(true);
    const ids = [await queueRepository.enqueue('order', { lines: [] }), await queueRepository.enqueue('visit', { outletId: 'o' }), await queueRepository.enqueue('payment', { amount: '5.00' })];
    const rows = (await queueRepository.listAll()).filter((e) => ids.includes(e.clientId));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe('PENDING');
      expect([r.userId, r.companyId]).toEqual(['uA', 'c1']);
    }
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('reconnect: only a fresh /auth/me of the same owner leaves local mode; mismatch locks the UK; offline stays local', async () => {
    await enrollA();
    await goOffline();
    await unlockOffline(A, PHRASE, mkDeps());
    expect((await reconnectFromLocal(async () => ({ kind: 'offline' }))).kind).toBe('still-offline');
    expect(getLocalOwner()).toEqual(A);
    const other = { ...userA, id: 'uB' };
    const mm = await reconnectFromLocal(async () => ({ kind: 'ok', user: other }));
    expect(mm.kind).toBe('mismatch');
    expect(isLocalMode()).toBe(false);
    expect(isVaultReadyFor(A)).toBe(false);

    await unlockOffline(A, PHRASE, mkDeps());
    expect((await reconnectFromLocal(async () => ({ kind: 'ok', user: userA }))).kind).toBe('ok');
    expect(isLocalMode()).toBe(false);
    expect(isSyncPaused()).toBe(false);
  });

  it('cross-tab switch to another owner ends local mode and locks A', async () => {
    await enrollA();
    await goOffline();
    await unlockOffline(A, PHRASE, mkDeps());
    const handler = vi.fn();
    const off = onUnauthorized(handler);
    setTokens(jwt(B), 'rB');
    expect(guardTokenOwner()).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionExpired: true }));
    off();
    setOfflineSession(B); // what the next sign-in does
    expect(isLocalMode()).toBe(false);
    expect(isVaultReadyFor(A)).toBe(false);
  });

  it('change passphrase needs the old one; the new one then unlocks, the old no longer', async () => {
    await enrollA();
    expect((await changePassphrase(A, userA, 'Nope-Nope-Nope-12', 'Green-Tiger-Moon-77', 'Green-Tiger-Moon-77', mkDeps())).kind).toBe('wrong-old');
    clock += 3_000; // the wrong old passphrase above started a backoff
    expect((await changePassphrase(A, userA, PHRASE, 'Green-Tiger-Moon-77', 'Green-Tiger-Moon-77', mkDeps())).kind).toBe('ok');
    await goOffline();
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('wrong');
    clock += 3_000;
    expect((await unlockOffline(A, 'Green-Tiger-Moon-77', mkDeps())).kind).toBe('ok');
  });

  it('fail-closed: missing IndexedDB / Web Crypto / WebAssembly / Worker disables the feature, online flow intact', async () => {
    expect(missingCapabilities({ indexedDB: 1, subtle: 1, WebAssembly: 1, Worker: 1 })).toEqual([]);
    expect(missingCapabilities({})).toEqual(['indexeddb', 'subtle', 'wasm', 'worker']);
    expect(missingCapabilities({ indexedDB: 1, subtle: 1, WebAssembly: 1 })).toEqual(['worker']);
    await readyVault(A);
    vi.stubGlobal('Worker', undefined);
    expect((await enrollOfflineUnlock(A, userA, PHRASE, PHRASE, {}, mkDeps())).kind).toBe('unsupported');
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('unsupported');
    expect(isVaultReadyFor(A)).toBe(true); // vault / online path untouched
  });

  it('KDF/worker errors are not wrong-passphrase verdicts (never counted) and do not weaken the KDF at enroll', async () => {
    await readyVault(A);
    expect((await enrollOfflineUnlock(A, userA, PHRASE, PHRASE, {}, mkDeps(A, { kdfBroken: true }))).kind).toBe('error');
    expect(await hasEntry(A)).toBe(false); // no silent FLOOR fallback on a non-memory error
    await enrollA();
    await goOffline();
    for (let i = 0; i < MAX_FAILURES + 2; i++) expect((await unlockOffline(A, PHRASE, mkDeps(A, { kdfBroken: true }))).kind).toBe('device-error');
    expect((await db.offlineUnlock.get([A.userId, A.companyId]))!.failCount).toBe(0);
    expect((await unlockOffline(A, PHRASE, mkDeps())).kind).toBe('ok');
  });

  it('failure counter is transactional (parallel failures all count) and a wrong OLD passphrase counts too', async () => {
    await enrollA();
    await goOffline();
    await Promise.all([1, 2, 3].map(() => unlockOffline(A, 'Wrong-Horse-Battery-9', mkDeps())));
    expect((await db.offlineUnlock.get([A.userId, A.companyId]))!.failCount).toBe(3);
    await patchRow({ nextAttemptAt: 0 });
    expect((await changePassphrase(A, userA, 'Nope-Nope-Nope-12', 'Green-Tiger-Moon-77', 'Green-Tiger-Moon-77', mkDeps())).kind).toBe('wrong-old');
    expect((await db.offlineUnlock.get([A.userId, A.companyId]))!.failCount).toBe(4);
  });

  it('reconnect keeps local mode ON until /auth/me is ok for the same owner; only /auth/me|refresh may pass during the probe', async () => {
    await enrollA();
    await goOffline();
    await unlockOffline(A, PHRASE, mkDeps());
    let during = false;
    const r = await reconnectFromLocal(async () => {
      during = isLocalMode() && isSyncPaused();
      await expect(apiFetch('/sync/push', { method: 'POST' })).rejects.toBeInstanceOf(LocalModeNetworkError);
      return { kind: 'ok', user: userA };
    });
    expect(during).toBe(true);
    expect(r.kind).toBe('ok');
    expect(isLocalMode()).toBe(false);
    await withVerificationProbe(async () => {});
  });
});
