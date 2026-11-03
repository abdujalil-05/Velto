import { fetchOfflineKek, type OfflineKek } from '@/lib/api/offline-kek';
import type { AuthenticatedUser } from '@/lib/api/types';
import { db, type OfflineUnlockRow, type UnlockKdfParams } from '../db';
import { enterLocalMode, isLocalMode, leaveLocalMode } from '../local-mode';
import { onSessionOwnerChange, setOfflineSession, type OfflineSession } from '../session';
import { adoptUnlockedKey, isVaultReadyFor, lockVault, openWithVault, sealWithVault } from '../vault';
import { offlineUnlockSupported } from './capabilities';
import { FLOOR_PARAMS, TARGET_PARAMS, workerDerive, type DeriveFn } from './kdf';
import { validatePassphrase, type PassphraseIssue } from './policy';

/**
 * Opt-in Offline Unlock (ADR-071). The entry stores ONLY the UK wrapped (AES-KW) by a key derived from the
 * passphrase with Argon2id (+ salt, params, counters) - never the passphrase, the derived key or the raw UK.
 * Everything below is additive: the vault/KEK path is untouched.
 */
export const UNLOCK_TTL_MS = 72 * 3600 * 1000;
export const MAX_FAILURES = 10;
const PROFILE_ID = 'offline-unlock-profile';
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 15 * 60_000;

export interface UnlockDeps {
  derive: DeriveFn;
  getKek: (version?: number) => Promise<OfflineKek>;
  now: () => number;
}
const defaultDeps = (): UnlockDeps => ({ derive: workerDerive, getKek: fetchOfflineKek, now: () => Date.now() });

/** Another account/company took over the session (cross-tab, token swap): local mode ends; the vault hook locks the previous UK. */
onSessionOwnerChange(() => leaveLocalMode());

const subtle = () => window.crypto.subtle;
const ownerSecret = (o: OfflineSession) => `${o.companyId}|${o.userId}`;
const key = (o: OfflineSession): [string, string] => [o.userId, o.companyId];

async function pwk(derive: DeriveFn, pass: string, salt: Uint8Array, params: UnlockKdfParams, owner: OfflineSession) {
  const raw = await derive(pass, salt, params, ownerSecret(owner));
  try {
    return await subtle().importKey('raw', raw as BufferSource, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
  } finally {
    raw.fill(0);
  }
}

const unwrapUk = (wrapped: ArrayBuffer, kek: CryptoKey, extractable: boolean) =>
  subtle().unwrapKey('raw', wrapped, kek, 'AES-KW', { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);

export async function hasEntry(owner: OfflineSession): Promise<boolean> {
  try {
    return !!(await db.offlineUnlock.get(key(owner)));
  } catch {
    return false;
  }
}

export async function getEntryMeta(owner: OfflineSession): Promise<Pick<OfflineUnlockRow, 'enrolledAt' | 'lastOnlineAt' | 'failCount' | 'params'> | null> {
  const r = await db.offlineUnlock.get(key(owner)).catch(() => undefined);
  return r ? { enrolledAt: r.enrolledAt, lastOnlineAt: r.lastOnlineAt, failCount: r.failCount, params: r.params } : null;
}

export async function deleteEntry(owner: OfflineSession | null): Promise<void> {
  if (!owner) return;
  await db.offlineUnlock.delete(key(owner)).catch(() => {});
}

export type EnrollResult = { kind: 'ok'; params: UnlockKdfParams } | { kind: 'unsupported' } | { kind: 'weak'; issues: PassphraseIssue[] } | { kind: 'vault-not-ready' } | { kind: 'offline-mode' } | { kind: 'error' };

/** RangeError (WebAssembly.Memory / allocation) or a worker-reported out-of-memory. Anything else is a device/worker error, not a reason to weaken the KDF. */
export function isMemoryError(e: unknown): boolean {
  return e instanceof RangeError || (e instanceof Error && (e.message === 'KDF_OOM' || /out of memory|memory|alloc/i.test(e.message)));
}

async function deriveWithFallback(deps: UnlockDeps, pass: string, salt: Uint8Array, owner: OfflineSession): Promise<{ key: CryptoKey; params: UnlockKdfParams }> {
  try {
    return { key: await pwk(deps.derive, pass, salt, TARGET_PARAMS, owner), params: TARGET_PARAMS };
  } catch (e) {
    // ONLY a clear memory error (device cannot allocate 64 MiB) falls back; the params actually used are stored per entry.
    if (!isMemoryError(e)) throw e;
    return { key: await pwk(deps.derive, pass, salt, FLOOR_PARAMS, owner), params: FLOOR_PARAMS };
  }
}

/** Online only, vault ready, fresh KEK fetched: wraps the UK under the passphrase-derived key. Overwrites an existing entry (change passphrase). */
export async function enrollOfflineUnlock(
  owner: OfflineSession,
  user: Pick<AuthenticatedUser, 'id' | 'companyId' | 'firstName' | 'lastName' | 'roles' | 'permissions'>,
  passphrase: string,
  confirm: string,
  ctx: { phone?: string } = {},
  deps: UnlockDeps = defaultDeps(),
): Promise<EnrollResult> {
  if (!offlineUnlockSupported()) return { kind: 'unsupported' };
  if (isLocalMode()) return { kind: 'offline-mode' };
  const issues = validatePassphrase(passphrase, { firstName: user.firstName, lastName: user.lastName, phone: ctx.phone }, confirm);
  if (issues.length) return { kind: 'weak', issues };
  if (!isVaultReadyFor(owner)) return { kind: 'vault-not-ready' };
  let kek: OfflineKek | null = null;
  let kek2: OfflineKek | null = null;
  try {
    const vrow = await db.vault.get(key(owner));
    if (!vrow) return { kind: 'vault-not-ready' };
    kek = await deps.getKek(); // fresh, online: proves the server still vouches for this user+company
    let wrapBytes = kek.bytes;
    if (vrow.kekVersion !== kek.version) {
      kek2 = await deps.getKek(vrow.kekVersion);
      wrapBytes = kek2.bytes;
    }
    const kekKey = await subtle().importKey('raw', wrapBytes as BufferSource, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
    const uk = await unwrapUk(vrow.wrappedUK, kekKey, true);
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const { key: wk, params } = await deriveWithFallback(deps, passphrase, salt, owner);
    const wrappedUK = await subtle().wrapKey('raw', uk, wk, 'AES-KW');
    const profile = await sealWithVault(owner, PROFILE_ID, minimalProfile(user));
    if (!profile) return { kind: 'vault-not-ready' };
    const now = deps.now();
    await db.offlineUnlock.put({
      userId: owner.userId,
      companyId: owner.companyId,
      fmt: 'pw1',
      wrappedUK,
      salt: salt.buffer as ArrayBuffer,
      params,
      kekVersion: kek.version,
      enrolledAt: now,
      lastOnlineAt: now,
      failCount: 0,
      nextAttemptAt: 0,
      profile,
    });
    return { kind: 'ok', params };
  } catch {
    return { kind: 'error' };
  } finally {
    kek?.bytes.fill(0);
    kek2?.bytes.fill(0);
  }
}

function minimalProfile(u: Pick<AuthenticatedUser, 'id' | 'companyId' | 'firstName' | 'lastName' | 'roles' | 'permissions'>): AuthenticatedUser {
  return { id: u.id, companyId: u.companyId, firstName: u.firstName, lastName: u.lastName, roles: u.roles, permissions: u.permissions } as AuthenticatedUser;
}

export type UnlockResult =
  | { kind: 'ok'; user: AuthenticatedUser }
  | { kind: 'no-entry' }
  | { kind: 'unsupported' }
  | { kind: 'expired' }
  | { kind: 'backoff'; retryAt: number }
  | { kind: 'wrong'; remaining: number }
  /** KDF/worker failure: not a passphrase verdict, never counted. */
  | { kind: 'device-error' }
  | { kind: 'wiped' }
  | { kind: 'error' };

type Verify = { kind: 'ok'; uk: CryptoKey } | { kind: 'wrong' } | { kind: 'kdf-error' };

/** Derive (KDF errors are NOT passphrase verdicts) then AES-KW unwrap (integrity failure = wrong passphrase or tampered/foreign wrap). */
async function verifyWrap(row: OfflineUnlockRow, owner: OfflineSession, pass: string, deps: UnlockDeps): Promise<Verify> {
  let wk: CryptoKey;
  try {
    wk = await pwk(deps.derive, pass, new Uint8Array(row.salt), row.params, owner);
  } catch {
    return { kind: 'kdf-error' };
  }
  try {
    return { kind: 'ok', uk: await unwrapUk(row.wrappedUK, wk, false) };
  } catch {
    return { kind: 'wrong' };
  }
}

/** Read-modify-write of the failure counter inside ONE rw transaction (two tabs cannot lose an increment). Deletes the entry at MAX_FAILURES. */
async function recordFailure(owner: OfflineSession, now: number): Promise<{ wiped: true } | { wiped: false; remaining: number }> {
  return db.transaction('rw', db.offlineUnlock, async () => {
    const cur = await db.offlineUnlock.get(key(owner));
    if (!cur) return { wiped: true as const };
    const failCount = cur.failCount + 1;
    if (failCount >= MAX_FAILURES) {
      await db.offlineUnlock.delete(key(owner));
      return { wiped: true as const };
    }
    // put, not Dexie update(): update() clones through plain objects and would destroy the ArrayBuffer fields (salt, wrappedUK)
    await db.offlineUnlock.put({ ...cur, failCount, nextAttemptAt: now + backoffMs(failCount) });
    return { wiped: false as const, remaining: MAX_FAILURES - failCount };
  });
}

/** TTL: refuse after 72 h without an online authentication, and when the device clock is behind the last online contact (rollback). */
export function ttlState(row: Pick<OfflineUnlockRow, 'lastOnlineAt'>, now: number): 'ok' | 'expired' | 'rollback' {
  if (now < row.lastOnlineAt) return 'rollback';
  if (now > row.lastOnlineAt + UNLOCK_TTL_MS) return 'expired';
  return 'ok';
}

export function backoffMs(failCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1), BACKOFF_CAP_MS);
}

/**
 * Opens the entry of `owner` (derived from the stored tokens, never from user input). On success the UK is adopted
 * in memory, the session becomes `owner` and LOCAL MODE starts (no network, no sync). Entry is kept on expiry/rollback.
 */
export async function unlockOffline(owner: OfflineSession, passphrase: string, deps: UnlockDeps = defaultDeps()): Promise<UnlockResult> {
  if (!offlineUnlockSupported()) return { kind: 'unsupported' };
  const row = await db.offlineUnlock.get(key(owner)).catch(() => undefined);
  if (!row) return { kind: 'no-entry' };
  const now = deps.now();
  if (ttlState(row, now) !== 'ok') return { kind: 'expired' };
  if (now < row.nextAttemptAt) return { kind: 'backoff', retryAt: row.nextAttemptAt };
  const v = await verifyWrap(row, owner, passphrase, deps);
  if (v.kind === 'kdf-error') return { kind: 'device-error' };
  if (v.kind === 'wrong') {
    const f = await recordFailure(owner, deps.now());
    return f.wiped ? { kind: 'wiped' } : { kind: 'wrong', remaining: f.remaining };
  }
  const uk = v.uk;
  setOfflineSession(owner); // before adopt: a different previous owner is locked by the owner-change hook
  adoptUnlockedKey(owner, uk);
  const user = row.profile ? await openWithVault<AuthenticatedUser>(owner, PROFILE_ID, row.profile) : undefined;
  if (!user || user.id !== owner.userId || user.companyId !== owner.companyId) {
    lockVault();
    return { kind: 'error' };
  }
  await db.transaction('rw', db.offlineUnlock, async () => {
    const cur = await db.offlineUnlock.get(key(owner));
    if (cur) await db.offlineUnlock.put({ ...cur, failCount: 0, nextAttemptAt: 0 });
  });
  enterLocalMode(owner);
  return { kind: 'ok', user };
}

/** Change passphrase: verifies the old one (no adoption), then re-enrolls with a fresh salt. */
export async function changePassphrase(
  owner: OfflineSession,
  user: Parameters<typeof enrollOfflineUnlock>[1],
  oldPass: string,
  newPass: string,
  confirm: string,
  deps: UnlockDeps = defaultDeps(),
): Promise<EnrollResult | { kind: 'wrong-old' }> {
  const row = await db.offlineUnlock.get(key(owner)).catch(() => undefined);
  if (!row || deps.now() < row.nextAttemptAt) return { kind: 'error' };
  const v = await verifyWrap(row, owner, oldPass, deps);
  if (v.kind === 'kdf-error') return { kind: 'error' };
  if (v.kind === 'wrong') {
    await recordFailure(owner, deps.now()); // a wrong old passphrase counts like a wrong unlock
    return { kind: 'wrong-old' };
  }
  return enrollOfflineUnlock(owner, user, newPass, confirm, {}, deps);
}

/** Called after each successful ONLINE authentication with the vault ready: moves the TTL anchor forward and refreshes the sealed profile. No-op in local mode / without an entry. */
export async function touchOnline(owner: OfflineSession, user: AuthenticatedUser | null, now: number = Date.now()): Promise<void> {
  if (isLocalMode()) return;
  const row = await db.offlineUnlock.get(key(owner)).catch(() => undefined);
  if (!row) return;
  const profile = user && isVaultReadyFor(owner) ? await sealWithVault(owner, PROFILE_ID, minimalProfile(user)) : null;
  await db.transaction('rw', db.offlineUnlock, async () => {
    const cur = await db.offlineUnlock.get(key(owner));
    if (cur) await db.offlineUnlock.put({ ...cur, lastOnlineAt: Math.max(now, cur.lastOnlineAt), profile: profile ?? cur.profile });
  });
}
