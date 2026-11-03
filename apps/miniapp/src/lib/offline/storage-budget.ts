import { db } from './db';
import { offlineRepository } from './repository';

// 10.2: "Umumiy hajm chegarasi 50 MB — oshsa eski ma'lumot tozalanadi
// (navbatga tegilmaydi)."
const STORAGE_LIMIT_BYTES = 50 * 1024 * 1024;

/** Best-effort — the Storage API isn't available in every WebView (notably some in-app Telegram browsers); "unknown" is treated as "under budget" rather than pruning speculatively. */
async function estimateUsageBytes(): Promise<number | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage } = await navigator.storage.estimate();
    return usage ?? null;
  } catch {
    return null;
  }
}

/** TZ 8.4: warn the user early — at 80% of the 50 MB budget — long before writes start failing. */
export const STORAGE_WARN_RATIO = 0.8;

export type StorageLevel = 'unknown' | 'ok' | 'warning' | 'full';

export interface StorageStatus {
  usageBytes: number | null;
  limitBytes: number;
  ratio: number | null;
  level: StorageLevel;
}

export function storageStatusFor(usage: number | null): StorageStatus {
  if (usage === null) return { usageBytes: null, limitBytes: STORAGE_LIMIT_BYTES, ratio: null, level: 'unknown' };
  const ratio = usage / STORAGE_LIMIT_BYTES;
  const level: StorageLevel = ratio >= 1 ? 'full' : ratio >= STORAGE_WARN_RATIO ? 'warning' : 'ok';
  return { usageBytes: usage, limitBytes: STORAGE_LIMIT_BYTES, ratio, level };
}

type StorageListener = (status: StorageStatus) => void;
const listeners = new Set<StorageListener>();
let lastStatus: StorageStatus = storageStatusFor(null);

/** UI subscribes (sync-engine.tsx exposes it as `storage`); fires on every publish. */
export function onStorageStatus(listener: StorageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLastStorageStatus(): StorageStatus {
  return lastStatus;
}

/** Re-reads usage and notifies subscribers — called after pulls, enqueues and on quota errors. */
export async function publishStorageStatus(): Promise<StorageStatus> {
  lastStatus = storageStatusFor(await estimateUsageBytes());
  listeners.forEach((l) => l(lastStatus));
  return lastStatus;
}

export interface StorageBudgetResult {
  evictedProducts: number;
  evictedCustomers: number;
}

/**
 * Called after every `/sync/pull` (sync-engine-core.ts). The only rows ever
 * safe to evict are reference data no longer needed to place a *new* order —
 * a deactivated product or a closed customer — never the `queue` table
 * (PENDING/SYNCING/FAILED/CONFLICT are untouchable; 10.3/10.4: "serverga yetib kelgan hujjat hech qachon jimgina yo'qolmaydi",
 * guaranteed-delivery documents are pruned only by queue.ts's own
 * age/status-based `pruneOld`, which never touches PENDING rows).
 * Dependents (packagings/prices/stock for a removed product, outlets/
 * balances for a removed customer) are cleaned up alongside their parent so
 * no orphaned rows are left behind.
 */
export async function enforceStorageBudget(): Promise<StorageBudgetResult | null> {
  const usage = await estimateUsageBytes();
  lastStatus = storageStatusFor(usage);
  listeners.forEach((l) => l(lastStatus));
  if (usage === null || usage <= STORAGE_LIMIT_BYTES) return null;

  const [products, customers] = await Promise.all([
    offlineRepository.products.toArray(),
    offlineRepository.customers.toArray(),
  ]);
  const inactiveProductIds = products.filter((p) => !p.isActive).map((p) => p.id);
  const inactiveCustomerIds = customers.filter((c) => !c.isActive).map((c) => c.id);

  await db.transaction(
    'rw',
    [db.products, db.packagings, db.prices, db.stock, db.customers, db.outlets, db.balances],
    async () => {
      if (inactiveProductIds.length > 0) {
        const [packagingKeys, priceKeys, stockKeys] = await Promise.all([
          db.packagings.where('productId').anyOf(inactiveProductIds).primaryKeys(),
          db.prices.where('productId').anyOf(inactiveProductIds).primaryKeys(),
          db.stock.where('productId').anyOf(inactiveProductIds).primaryKeys(),
        ]);
        await Promise.all([
          db.packagings.bulkDelete(packagingKeys),
          db.prices.bulkDelete(priceKeys),
          db.stock.bulkDelete(stockKeys),
          db.products.bulkDelete(inactiveProductIds),
        ]);
      }
      if (inactiveCustomerIds.length > 0) {
        const outletKeys = await db.outlets.where('customerId').anyOf(inactiveCustomerIds).primaryKeys();
        await Promise.all([
          db.outlets.bulkDelete(outletKeys),
          db.customers.bulkDelete(inactiveCustomerIds),
          db.balances.bulkDelete(inactiveCustomerIds),
        ]);
      }
    },
  );

  return { evictedProducts: inactiveProductIds.length, evictedCustomers: inactiveCustomerIds.length };
}
