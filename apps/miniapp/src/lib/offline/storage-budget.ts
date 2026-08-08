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

export interface StorageBudgetResult {
  evictedProducts: number;
  evictedCustomers: number;
}

/**
 * Called after every `/sync/pull` (sync-engine-core.ts). The only rows ever
 * safe to evict are reference data no longer needed to place a *new* order —
 * a deactivated product or a closed customer — never the `queue` table
 * (10.3/10.4: "serverga yetib kelgan hujjat hech qachon jimgina yo'qolmaydi",
 * guaranteed-delivery documents are pruned only by queue.ts's own
 * age/status-based `pruneOld`, which never touches PENDING rows).
 * Dependents (packagings/prices/stock for a removed product, outlets/
 * balances for a removed customer) are cleaned up alongside their parent so
 * no orphaned rows are left behind.
 */
export async function enforceStorageBudget(): Promise<StorageBudgetResult | null> {
  const usage = await estimateUsageBytes();
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
