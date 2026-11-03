import { fetchOfflineKek, OfflineKekRetiredError, type OfflineKek } from '@/lib/api/offline-kek';
import type { EncryptedBlob } from './crypto';
import { db } from './db';
import { onSessionOwnerChange, type OfflineSession } from './session';

/**
 * Per-(userId, companyId) vault key "UK" (random AES-GCM-256) protecting PAYMENT
 * queue rows (incl. held CONFLICT/UNVERIFIABLE ones). Persisted ONLY as
 * {userId, companyId, kekVersion, wrappedUK}: the UK wrapped (AES-KW) by the
 * server-issued KEK of that user+company. The KEK is fetched online after
 * /auth/me and used for one operation; the unwrapped UK lives in memory as a
 * NON-extractable CryptoKey. Logout / session end drops it, so nothing needed to
 * read the rows exists on the device without a fresh authenticated KEK fetch.
 * Web Crypto only; nothing here logs keys or rows.
 */

export const UK_FORMAT = 'uk1';
const IV_LENGTH = 12;

export type VaultStatus =
  /** No UK in memory (not signed in yet / signed out / restoring). */
  | 'locked'
  | 'ready'
  /** KEK could not be obtained (offline, 401, 429, 5xx) or unwrap failed: vault rows stay locked, creating payments is blocked. */
  | 'unavailable'
  /** Server answered 410: the KEK version that wrapped the UK is retired. Rows stay locked (never deleted). */
  | 'retired';

export class VaultUnavailableError extends Error {
  readonly code = 'VAULT_UNAVAILABLE';
  constructor() {
    super('Vault key unavailable: document cannot be saved on this device');
    this.name = 'VaultUnavailableError';
  }
}

/** Legacy device-key rows (orders/visits/payments) owned by ANOTHER user/company sit on this device: the shared key can still open them, so no offline work may start until their owner signs in and seals them. */
export class ForeignLegacyBlockedError extends Error {
  readonly code = 'FOREIGN_LEGACY_ROWS';
  constructor() {
    super('Legacy device-key documents of another or unknown owner are on this device');
    this.name = 'ForeignLegacyBlockedError';
  }
}

/** Pilot policy "new build only": payment rows still under the shared device key cannot be trusted or moved automatically, so creating/sending payments stays blocked until they are resolved manually. */
export class LegacyPaymentsBlockedError extends Error {
  readonly code = 'LEGACY_PAYMENTS_UNRESOLVED';
  constructor() {
    super('Unresolved legacy device-key payment rows: payments are blocked');
    this.name = 'LegacyPaymentsBlockedError';
  }
}

let status: VaultStatus = 'locked';
let legacyPaymentRows = 0;
let foreignLegacyRows = 0;
let active: { userId: string; companyId: string; key: CryptoKey } | null = null;
let generation = 0;
/** True while the in-memory UK came from an Offline Unlock passphrase (ADR-071), not from the server KEK: the next online bring-up must still go through the KEK path (rotation, retired). */
let adoptedLocal = false;
let pending: { userId: string; companyId: string } | null = null;
const listeners = new Set<() => void>();

function setStatus(next: VaultStatus): void {
  if (status === next) return;
  status = next;
  for (const l of [...listeners]) l();
}

export function getVaultStatus(): VaultStatus {
  return status;
}
export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const subtle = () => window.crypto.subtle;
const importKek = (bytes: Uint8Array) => subtle().importKey('raw', bytes as BufferSource, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
const wrapUk = (uk: CryptoKey, kek: CryptoKey) => subtle().wrapKey('raw', uk, kek, 'AES-KW');
const unwrapUk = (wrapped: ArrayBuffer, kek: CryptoKey, extractable: boolean) =>
  subtle().unwrapKey('raw', wrapped, kek, 'AES-KW', { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);

/** Binds a ciphertext to company | user | row | format version. */
function aad(companyId: string, userId: string, clientId: string): BufferSource {
  return new TextEncoder().encode(`${companyId}|${userId}|${clientId}|${UK_FORMAT}`) as BufferSource;
}

function isConstraint(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'ConstraintError';
}

async function openOrCreate(session: OfflineSession, getKek: (version?: number) => Promise<OfflineKek>, attempt = 0): Promise<CryptoKey> {
  const { userId, companyId } = session;
  const cur = await getKek();
  try {
    const kek = await importKek(cur.bytes);
    const row = await db.vault.get([userId, companyId]);
    if (!row) {
      const uk = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const wrappedUK = await wrapUk(uk, kek);
      try {
        await db.vault.add({ userId, companyId, kekVersion: cur.version, wrappedUK });
      } catch (e) {
        if (isConstraint(e) && attempt < 1) return openOrCreate(session, getKek, attempt + 1); // another tab created it first
        throw e;
      }
      return unwrapUk(wrappedUK, kek, false);
    }
    if (row.kekVersion === cur.version) return await unwrapUk(row.wrappedUK, kek, false);

    // Rotation: open under the stored (older) version, rewrap under the current one.
    const old = await getKek(row.kekVersion);
    try {
      const ext = await unwrapUk(row.wrappedUK, await importKek(old.bytes), true);
      const wrappedUK = await wrapUk(ext, kek);
      await db.vault.put({ userId, companyId, kekVersion: cur.version, wrappedUK });
      return await unwrapUk(wrappedUK, kek, false);
    } finally {
      old.bytes.fill(0);
    }
  } finally {
    cur.bytes.fill(0);
  }
}

/**
 * Session-ready step (after /auth/me): obtain the UK for this user+company,
 * creating it on the first online session and rotating its wrap when the
 * server KEK moved on. Never deletes anything; on any failure the vault stays
 * locked and the reason is the returned status.
 */
/** True when the owner's UK is already in memory from a previous bring-up (no network was needed to get it). */
export function isVaultActiveFor(session: OfflineSession): boolean {
  return !adoptedLocal && !!active && active.userId === session.userId && active.companyId === session.companyId;
}

export async function ensureVault(session: OfflineSession, getKek: (version?: number) => Promise<OfflineKek> = fetchOfflineKek): Promise<VaultStatus> {
  if (!adoptedLocal && active && active.userId === session.userId && active.companyId === session.companyId) return 'ready';
  const gen = ++generation;
  active = null;
  adoptedLocal = false;
  pending = { userId: session.userId, companyId: session.companyId };
  setStatus('locked');
  let key: CryptoKey | null = null;
  let next: VaultStatus = 'ready';
  try {
    key = await openOrCreate(session, getKek);
  } catch (e) {
    next = e instanceof OfflineKekRetiredError ? 'retired' : 'unavailable';
    // ADR-071: a retired KEK version means the server no longer vouches for this vault: the offline-unlock entry goes too.
    if (next === 'retired') await db.offlineUnlock.delete([session.userId, session.companyId]).catch(() => {});
  }
  if (gen !== generation) return status; // logout / another session took over meanwhile
  pending = null;
  if (key) active = { userId: session.userId, companyId: session.companyId, key };
  setStatus(next);
  return next;
}

/**
 * Offline Unlock (ADR-071): puts a UK unwrapped with the offline passphrase into memory for `owner`
 * (non-extractable). No network, nothing persisted. Replaces any other owner's key.
 */
export function adoptUnlockedKey(owner: OfflineSession, key: CryptoKey): void {
  generation += 1;
  pending = null;
  active = { userId: owner.userId, companyId: owner.companyId, key };
  adoptedLocal = true;
  setStatus('ready');
}

/** Account/company switch without a logout in between: the previous owner's UK must not stay in memory. */
onSessionOwnerChange(() => lockVault());

/** Drops the UK from memory (logout, session end, revoke). Persisted rows are untouched. */
export function lockVault(): void {
  generation += 1;
  active = null;
  adoptedLocal = false;
  pending = null;
  setStatus('locked');
}

/**
 * Owner-scoped lock for a deferred session end: a no-op when the vault (active or being opened) now belongs
 * to a different user/company, so a late end of A's session cannot lock B's vault. No owner = plain lock.
 */
export function lockVaultFor(owner: { userId: string; companyId: string } | null): void {
  const cur = active ?? pending;
  if (owner && cur && (cur.userId !== owner.userId || cur.companyId !== owner.companyId)) return;
  lockVault();
}

export function isVaultReadyFor(owner: OfflineSession): boolean {
  return !!active && active.userId === owner.userId && active.companyId === owner.companyId;
}

export function assertVaultReady(owner: OfflineSession): void {
  if (!isVaultReadyFor(owner)) throw new VaultUnavailableError();
}

/** Encrypts under the owner's UK; null when the vault is not ready for that owner. */
export async function sealWithVault(owner: OfflineSession, clientId: string, value: unknown): Promise<EncryptedBlob | null> {
  if (!active || !isVaultReadyFor(owner)) return null;
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(owner.companyId, owner.userId, clientId) },
    active.key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { iv, ct, v: UK_FORMAT };
}

/** Decrypts a vault blob; undefined = locked (no UK for this owner) or tampered/foreign. */
export async function openWithVault<T>(owner: OfflineSession, clientId: string, blob: EncryptedBlob): Promise<T | undefined> {
  if (!active || !isVaultReadyFor(owner) || blob.v !== UK_FORMAT) return undefined;
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: blob.iv as BufferSource, additionalData: aad(owner.companyId, owner.userId, clientId) },
      active.key,
      blob.ct,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return undefined;
  }
}

/** Queue rows still encrypted under the shared device key (everything not in vault format). Zero => the device key can be dropped. */
export async function countDeviceKeyRows(): Promise<number> {
  const rows = await db.queue.toArray();
  return rows.filter((r) => r._enc?.v !== UK_FORMAT).length;
}

/** PAYMENT rows still in the legacy device-key format, any owner (an ownerless/foreign/unmigratable one is never auto-adopted or deleted). */
export async function countDeviceKeyPaymentRows(): Promise<number> {
  return db.queue.where('type').equals('payment').filter((r) => r._enc?.v !== UK_FORMAT).count();
}

export function getLegacyPaymentRows(): number {
  return legacyPaymentRows;
}

/**
 * Rows (any type) still under the shared device key that do not provably belong to `owner`: other user, other
 * company, or ownerless (no verifiable creator). Counted from plaintext owner columns only: never decrypted. No owner = 0.
 */
export async function countForeignLegacyRows(owner: OfflineSession | null): Promise<number> {
  if (!owner) return 0;
  return db.queue.filter((r) => r._enc?.v !== UK_FORMAT && (!r.userId || r.userId !== owner.userId || r.companyId !== owner.companyId)).count();
}

export function getForeignLegacyRows(): number {
  return foreignLegacyRows;
}

export async function assertNoForeignLegacy(owner: OfflineSession): Promise<void> {
  if ((await countForeignLegacyRows(owner)) > 0) throw new ForeignLegacyBlockedError();
}

/** Startup / after bring-up: re-detects legacy payment rows (and foreign legacy rows relative to `owner`) from IndexedDB and notifies the UI. */
export async function refreshLegacyPaymentRows(owner: OfflineSession | null = null): Promise<number> {
  legacyPaymentRows = await countDeviceKeyPaymentRows();
  foreignLegacyRows = await countForeignLegacyRows(owner);
  for (const l of [...listeners]) l();
  return legacyPaymentRows;
}

export async function assertNoLegacyPayments(): Promise<void> {
  if ((await countDeviceKeyPaymentRows()) > 0) throw new LegacyPaymentsBlockedError();
}

/** Emergency wipe only: destroys the wrapped keys (rows become permanently unreadable). */
export async function wipeVaultKeys(): Promise<void> {
  lockVault();
  await db.vault.clear();
  await db.offlineUnlock.clear(); // ADR-071: the passphrase-wrapped copy of the UK goes with the server-wrapped one
}
