import { clearDeviceKey } from './crypto';
import { countDeviceKeyRows, lockVault } from './vault';
import { stopSyncAndWait } from './sync-engine-core';
import { db } from './db';
import { queueRepository } from './queue';
import { wipeReferenceCache } from './repository';
import { forgetLastKnownOwner, getLastKnownOwner, getOwnerTelegramId, setOfflineSession, type OfflineSession } from './session';
import { resetPreparedSession } from './session-bootstrap';

/**
 * Server-confirmed revoke / block (refresh answered 401|403; never a network
 * error): TZ 8.6 says the real protection is the wipe. Order matters and every
 * step is idempotent, so a kill in the middle is finished by the next call:
 *   1. unsynced queue rows -> quarantine (ADR-022: kept, owner-tagged, never pushed)
 *   2. reference cache + dataset sync times + pull cursors -> cleared
 *   3. device key dropped ONLY if no queue row survives (else the quarantined
 *      documents would become undecryptable = lost; they are the agent's own
 *      work and stay exportable). The key sits beside the data anyway (crypto.ts),
 *      so keeping it for those rows adds no protection loss the cache wipe didn't cover.
 */
const REVOKED_KEY = 'velto.revoked';

export interface RevokedInfo extends OfflineSession {
  at: string;
  /** Telegram id of the quarantine owner, when this device ever saw it (client-side export gate only). */
  telegramId?: string;
}

/** Export of quarantined documents is offered only inside a Telegram session whose user id equals the owner's. Client-side check, not a security guarantee. */
export function canExportRevoked(info: Pick<RevokedInfo, 'telegramId'>, currentTelegramId: number | string | null | undefined): boolean {
  return !!info.telegramId && currentTelegramId != null && String(currentTelegramId) === info.telegramId;
}

let inFlight: Promise<RevokedInfo | null> | null = null;

export function getRevokedInfo(): RevokedInfo | null {
  try {
    const raw = window.localStorage.getItem(REVOKED_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<RevokedInfo>) : null;
    return v?.userId && v.companyId ? { userId: v.userId, companyId: v.companyId, at: v.at ?? '', telegramId: v.telegramId } : null;
  } catch {
    return null;
  }
}

export function clearRevokedInfo(): void {
  try {
    window.localStorage.removeItem(REVOKED_KEY);
  } catch {
    /* ignore */
  }
}

export function handleSessionRevoked(): Promise<RevokedInfo | null> {
  if (!inFlight) {
    inFlight = run().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function run(): Promise<RevokedInfo | null> {
  const owner = getLastKnownOwner() ?? getRevokedInfo();
  const telegramId = getOwnerTelegramId() ?? getRevokedInfo()?.telegramId;
  if (owner) {
    await stopSyncAndWait(); // abort + bounded wait: nothing pushes while we quarantine/seal
    await queueRepository.quarantineOwnerEntries(owner);
    await queueRepository.sealOwnRowsToVault(owner); // everything of the owner still under the device key -> vault key
  }
  await wipeReferenceCache();
  await db.meta.delete('cacheOwner');
  setOfflineSession(null);
  resetPreparedSession();
  forgetLastKnownOwner();
  lockVault();
  if ((await countDeviceKeyRows()) === 0) clearDeviceKey();

  const info = owner ? { userId: owner.userId, companyId: owner.companyId, at: getRevokedInfo()?.at || new Date().toISOString(), telegramId } : null;
  if (info && (await queueRepository.countOwnRows(info)) > 0) {
    window.localStorage.setItem(REVOKED_KEY, JSON.stringify(info));
    return info;
  }
  clearRevokedInfo();
  return null;
}
