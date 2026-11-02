import { fetchOfflineKek, type OfflineKek } from '@/lib/api/offline-kek';
import { fetchReconciliationStatus } from '@/lib/api/payments';
import { clearDeviceKey } from './crypto';
import { clearOfflineDb, db } from './db';
import { countDeviceKeyPaymentRows, countDeviceKeyRows, ensureVault, lockVault, refreshLegacyPaymentRows, wipeVaultKeys, type VaultStatus } from './vault';
import { queueRepository, type QueueEntry } from './queue';
import { getSyncSignal, type OfflineSession } from './session';

/**
 * Held payments (PAYMENT_IDEMPOTENCY_CONFLICT/UNVERIFIABLE) live in the queue
 * encrypted under the owner's vault key (vault.ts) from the moment they are
 * written, so logout needs no network and no sealing step. This module keeps:
 *  - login: bring the vault up, move legacy device-key payment rows into it,
 *    restore legacy `sealed` rows (v1 per-row DEK format) into it;
 *  - logout: move whatever of the owner's rows is still under the device key
 *    into the vault (local only);
 *  - server-confirmed resolution and the explicit emergency wipe.
 */

const subtle = () => window.crypto.subtle;

function importKek(bytes: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', bytes as BufferSource, 'AES-KW', false, ['unwrapKey']);
}

/** Legacy sealed-row AAD (v1). */
function aad(clientId: string, userId: string, companyId: string): BufferSource {
  return new TextEncoder().encode(`${clientId}|${userId}|${companyId}`) as BufferSource;
}

export async function hasSealedFor(owner: OfflineSession): Promise<boolean> {
  return (await db.sealed.where('ownerUserId').equals(owner.userId).filter((r) => r.ownerCompanyId === owner.companyId).count()) > 0;
}

/**
 * Legacy v1 sealed rows -> queue under the vault key (vault must be ready). Each
 * row is opened with the KEK of its own `kekVersion`; the sealed copy is deleted
 * only after the queue write succeeded. A row that cannot be opened (retired
 * version, wrong KEK, tampered) stays sealed untouched and is counted in `failed`.
 */
export async function restoreSealedFor(
  owner: OfflineSession,
  getKek: (version?: number) => Promise<OfflineKek> = fetchOfflineKek,
): Promise<{ restored: number; failed: number }> {
  const rows = (await db.sealed.where('ownerUserId').equals(owner.userId).toArray()).filter((r) => r.ownerCompanyId === owner.companyId);
  if (rows.length === 0) return { restored: 0, failed: 0 };
  let restored = 0;
  let failed = 0;
  const byVersion = new Map<number, typeof rows>();
  for (const r of rows) byVersion.set(r.kekVersion, [...(byVersion.get(r.kekVersion) ?? []), r]);
  for (const [version, group] of byVersion) {
    let kekBytes: Uint8Array;
    try {
      kekBytes = (await getKek(version)).bytes;
    } catch {
      failed += group.length; // offline / retired: stays sealed
      continue;
    }
    const kek = await importKek(kekBytes);
    for (const r of group) {
      try {
        const dek = await subtle().unwrapKey('raw', r.wrappedDek, kek, 'AES-KW', 'AES-GCM', false, ['decrypt']);
        const plain = await subtle().decrypt(
          { name: 'AES-GCM', iv: r.iv as BufferSource, additionalData: aad(r.clientId, r.ownerUserId, r.ownerCompanyId) },
          dek,
          r.ciphertext,
        );
        const entry = JSON.parse(new TextDecoder().decode(plain)) as QueueEntry;
        if (entry.clientId !== r.clientId || entry.userId !== owner.userId || entry.companyId !== owner.companyId) {
          failed += 1;
          continue;
        }
        await queueRepository.restoreHeldEntry(entry);
        await db.sealed.delete(r.clientId);
        restored += 1;
      } catch {
        failed += 1;
      }
    }
    kekBytes.fill(0);
  }
  return { restored, failed };
}

export interface VaultBringUp {
  status: VaultStatus;
  /** Legacy sealed rows that could not be opened (kept sealed, never deleted). */
  legacyFailed: number;
}

/** Session-ready (after /auth/me): vault up, then legacy device-key payments and legacy sealed rows are migrated into it. Safe to repeat. */
export async function bringUpVault(owner: OfflineSession, getKek: (version?: number) => Promise<OfflineKek> = fetchOfflineKek): Promise<VaultBringUp> {
  const status = await ensureVault(owner, getKek);
  if (status !== 'ready') {
    await refreshLegacyPaymentRows();
    return { status, legacyFailed: 0 };
  }
  await queueRepository.claimLegacyEntries(owner); // ownerless legacy payments naming this user as creator need the vault
  await queueRepository.sealOwnRowsToVault(owner, { onlyPayments: true });
  const legacyFailed = (await hasSealedFor(owner)) ? (await restoreSealedFor(owner, getKek)).failed : 0;
  await refreshLegacyPaymentRows();
  return { status, legacyFailed };
}

/**
 * Logout step (no network): the owner's rows still under the device key move to
 * the vault key. 'pending' = some PAYMENT row could not be moved (vault was not
 * ready); it stays readable only with the device key and the caller warns.
 */
export interface SealForLogout {
  state: 'sealed' | 'pending';
  /** Owner PAYMENT rows that are STILL under the shared device key (caller must warn explicitly). */
  remainingPayments: number;
  /** IndexedDB could not be read/written: local data was NOT confirmed saved (caller warns, never claims "safely saved"). */
  unconfirmed?: boolean;
}
export async function sealOwnerForLogout(owner: OfflineSession): Promise<SealForLogout> {
  try {
    await queueRepository.sealOwnRowsToVault(owner);
    // Any payment row left under the shared device key (own, foreign or ownerless) keeps the device from being reported safe.
    const remainingPayments = await countDeviceKeyPaymentRows();
    return { state: remainingPayments === 0 ? 'sealed' : 'pending', remainingPayments };
  } catch {
    return { state: 'pending', remainingPayments: 0, unconfirmed: true };
  }
}

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/**
 * Online session start: bring the vault up (and migrate this owner's device-key payments into it). While it
 * fails for a transient reason ('unavailable': 429/503/timeout/offline) it is retried with backoff for the
 * whole session; 'retired' (410) and success end the loop. `isCurrent` lets the caller stop when the session ended.
 */
export async function bringUpVaultWithRetry(
  owner: OfflineSession,
  opts: { getKek?: (version?: number) => Promise<OfflineKek>; delaysMs?: number[]; isCurrent?: () => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<VaultBringUp> {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let res = await bringUpVault(owner, opts.getKek);
  for (const d of delays) {
    if (res.status !== 'unavailable' || (opts.isCurrent && !opts.isCurrent())) break;
    await sleep(d);
    if (opts.isCurrent && !opts.isCurrent()) break;
    res = await bringUpVault(owner, opts.getKek);
  }
  return res;
}

export type HeldResolution = 'EXISTING_PAYMENT_CONFIRMED' | 'NOT_POSTED_CONFIRMED';
export interface HeldResolved {
  clientId: string;
  outcome: HeldResolution;
}

const STATUS_BATCH = 100;

/**
 * Asks the server about the owner's held rows. ONLY an explicit
 * EXISTING_PAYMENT_CONFIRMED / NOT_POSTED_CONFIRMED for that exact clientId
 * removes the row; OPEN, UNKNOWN, a missing item or any error keep it. Never
 * creates or resends a payment. Returns what was resolved (for the user message).
 */
export async function resolveHeldRows(): Promise<HeldResolved[]> {
  const held = await queueRepository.listHeld();
  const resolved: HeldResolved[] = [];
  for (let i = 0; i < held.length; i += STATUS_BATCH) {
    const ids = held.slice(i, i + STATUS_BATCH).map((e) => e.clientId);
    let items: { clientId: string; status: string }[];
    try {
      ({ items } = await fetchReconciliationStatus(ids, getSyncSignal()));
    } catch {
      return resolved; // offline / 401 / 5xx: keep everything
    }
    const asked = new Set(ids);
    for (const it of items ?? []) {
      if (!asked.has(it.clientId)) continue;
      if (it.status !== 'EXISTING_PAYMENT_CONFIRMED' && it.status !== 'NOT_POSTED_CONFIRMED') continue;
      if (await queueRepository.removeResolvedHeld(it.clientId)) resolved.push({ clientId: it.clientId, outcome: it.status });
    }
  }
  return resolved;
}

/**
 * Local half of logout, after tokens are gone: wipes the reference cache (the queue stays whenever any
 * row exists - other owners' and this owner's vault rows), drops the device key only when no queue row
 * still depends on it, drops the UK from memory. No network.
 */
export async function wipeLocalAfterLogout(): Promise<void> {
  const rows = await queueRepository.queueRowCount();
  await clearOfflineDb({ keepQueue: rows > 0 });
  if ((await countDeviceKeyRows()) === 0) clearDeviceKey();
  lockVault();
}

/**
 * Emergency wipe (distinct from logout): destroys ALL local evidence - queue
 * (incl. held), sealed table, wrapped vault keys, reference cache, device key.
 * Caller must have shown the explicit warning + confirm step.
 */
export async function emergencyWipe(): Promise<void> {
  await clearOfflineDb({ keepQueue: false });
  await db.sealed.clear();
  await wipeVaultKeys();
  clearDeviceKey();
}
