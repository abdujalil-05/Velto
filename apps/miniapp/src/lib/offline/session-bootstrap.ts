import { queueRepository } from './queue';
import { ensureCacheOwner } from './repository';
import { getOfflineSession, sessionKey } from './session';

let preparedFor: string | null = null;

/** Once per session: wipe a previous user's reference cache (queue untouched), claim only provably-own pre-v3 rows (rest stay quarantined), release SYNCING leftovers of a killed process. Returns false without a session. */
export async function prepareOfflineSession(): Promise<boolean> {
  const session = getOfflineSession();
  if (!session) return false;
  const key = sessionKey(session);
  if (preparedFor === key) return true;
  await ensureCacheOwner(session);
  await queueRepository.claimLegacyEntries(session);
  await queueRepository.releaseStaleSyncing();
  preparedFor = key;
  return true;
}

/** Test/logout hook. */
export function resetPreparedSession(): void {
  preparedFor = null;
}
