'use client';

import { useSyncExternalStore } from 'react';
import { getForeignLegacyRows, getLegacyPaymentRows, getVaultStatus, subscribeVault, type VaultStatus } from './vault';

/** Live vault status; payments can be created only while 'ready'. */
export function useVaultStatus(): VaultStatus {
  return useSyncExternalStore(subscribeVault, getVaultStatus, () => 'locked' as VaultStatus);
}

/** Count of legacy device-key payment rows detected at startup/bring-up; > 0 blocks financial use. */
export function useLegacyPaymentRows(): number {
  return useSyncExternalStore(subscribeVault, getLegacyPaymentRows, () => 0);
}

/** Count of device-key documents owned by ANOTHER user/company; > 0 blocks offline work for the signed-in user. */
export function useForeignLegacyRows(): number {
  return useSyncExternalStore(subscribeVault, getForeignLegacyRows, () => 0);
}
