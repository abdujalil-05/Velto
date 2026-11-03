import { sealOwnerForLogout, wipeCacheKeepQueue, type SealForLogout } from './held-seal';
import { getOfflineSession, type OfflineSession } from './session';
import { stopSyncAndWait } from './sync-engine-core';
import { lockVaultFor } from './vault';

/**
 * Session ends without a user-driven logout (token expired / refused): same order as logout - stop and abort
 * sync (bounded wait), move the owner's rows still under the device key into the vault key, THEN drop the UK and wipe the reference cache (device key dropped only when no row depends on it).
 * Local only; never needs the network.
 */
export async function endSessionSealing(owner: OfflineSession | null): Promise<SealForLogout> {
  await stopSyncAndWait();
  try {
    return owner ? await sealOwnerForLogout(owner) : { state: 'sealed', remainingPayments: 0 };
  } finally {
    lockVaultFor(owner);
    // (skipped when another user already signed in.) Reference cache (company A) must not stay readable with the localStorage key for the next user; pending queue rows stay.
    const now = getOfflineSession();
    if (!now || (owner && now.userId === owner.userId && now.companyId === owner.companyId)) await wipeCacheKeepQueue().catch(() => {});
  }
}
