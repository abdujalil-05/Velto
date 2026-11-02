import { sealOwnerForLogout, type SealForLogout } from './held-seal';
import type { OfflineSession } from './session';
import { stopSyncAndWait } from './sync-engine-core';
import { lockVaultFor } from './vault';

/**
 * Session ends without a user-driven logout (token expired / refused): same order as logout - stop and abort
 * sync (bounded wait), move the owner's rows still under the device key into the vault key, THEN drop the UK.
 * Local only; never needs the network.
 */
export async function endSessionSealing(owner: OfflineSession | null): Promise<SealForLogout> {
  await stopSyncAndWait();
  try {
    return owner ? await sealOwnerForLogout(owner) : { state: 'sealed', remainingPayments: 0 };
  } finally {
    lockVaultFor(owner);
  }
}
