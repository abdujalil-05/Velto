/**
 * Per-dataset "last successful sync" and staleness (TZ 8.6). The TZ says stock, customer credit and price TTLs are
 * configurable but gives NO values, so the threshold is a deployment setting (NEXT_PUBLIC_STALE_HOURS_<DATASET>, hours)
 * that falls back to DEFAULT_STALE_HOURS (the pre-existing 24 h placeholder, pending a product decision).
 * Stale data only warns: drafts are still allowed; nothing is changed silently.
 */
export const DATASET_KEYS = ['products', 'prices', 'customers', 'stock', 'balances', 'route'] as const;
export type DatasetKey = (typeof DATASET_KEYS)[number];

export const DEFAULT_STALE_HOURS = 24;

/** Next inlines NEXT_PUBLIC_* only for literal `process.env.X` reads — hence the explicit table. */
function envHours(key: DatasetKey): string | undefined {
  switch (key) {
    case 'products': return process.env.NEXT_PUBLIC_STALE_HOURS_PRODUCTS;
    case 'prices': return process.env.NEXT_PUBLIC_STALE_HOURS_PRICES;
    case 'customers': return process.env.NEXT_PUBLIC_STALE_HOURS_CUSTOMERS;
    case 'stock': return process.env.NEXT_PUBLIC_STALE_HOURS_STOCK;
    case 'balances': return process.env.NEXT_PUBLIC_STALE_HOURS_BALANCES;
    case 'route': return process.env.NEXT_PUBLIC_STALE_HOURS_ROUTE;
  }
}

export function staleAfterMs(key: DatasetKey, raw: string | undefined = envHours(key)): number {
  const h = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_STALE_HOURS) * 3_600_000;
}

/** Never synced (null/unparseable) counts as stale. */
export function isDatasetStale(lastSyncAt: string | null, key: DatasetKey, now: number = Date.now(), ttlMs: number = staleAfterMs(key)): boolean {
  if (!lastSyncAt) return true;
  const t = Date.parse(lastSyncAt);
  return Number.isNaN(t) || now - t > ttlMs;
}
