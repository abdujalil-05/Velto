import type {
  SyncBalance,
  SyncCategory,
  SyncCustomer,
  SyncOutlet,
  SyncPackaging,
  SyncPriceItem,
  SyncProduct,
  SyncPullResult,
  SyncRoute,
  SyncRouteStop,
  SyncScope,
  SyncStock,
} from '@/lib/api/sync';
import { db, type RawRow } from './db';
import { EncryptedStore } from './encrypted-store';
import { getOfflineSession, sessionKey, type OfflineSession } from './session';

// One EncryptedStore per Dexie table, key fields matching db.ts's `stores()`
// index declarations exactly (10.2).
const products = new EncryptedStore<SyncProduct, string>(db.products as never, ['id', 'sku', 'name', 'categoryId']);
const packagings = new EncryptedStore<SyncPackaging, string>(db.packagings as never, ['id', 'productId']);
const prices = new EncryptedStore<SyncPriceItem, [string, string]>(db.prices as never, ['priceListId', 'productId']);
const customers = new EncryptedStore<SyncCustomer, string>(db.customers as never, ['id', 'code', 'name']);
const outlets = new EncryptedStore<SyncOutlet, string>(db.outlets as never, ['id', 'customerId']);
const stock = new EncryptedStore<SyncStock, [string, string]>(db.stock as never, ['productId', 'warehouseId']);
const categories = new EncryptedStore<SyncCategory, string>(db.categories as never, ['id', 'parentId']);
const balances = new EncryptedStore<SyncBalance, string>(db.balances as never, ['customerId']);
const routes = new EncryptedStore<SyncRoute, string>(db.routes as never, ['id', 'weekday']);
const routeStops = new EncryptedStore<SyncRouteStop, string>(db.routeStops as never, ['id', 'routeId', 'outletId']);

const DEFAULT_PRICE_LIST_KEY = 'defaultPriceListId';
const CACHE_OWNER_KEY = 'cacheOwner';

/** Per-user pull state: opaque server cursor + last known agent scope. */
export interface PullState {
  cursor?: string;
  scope: SyncScope | null;
}

function pullStateKey(session: OfflineSession): string {
  return `pull:${sessionKey(session)}`;
}

export async function getPullState(): Promise<PullState> {
  const session = getOfflineSession();
  if (!session) return { scope: null };
  const row = await db.meta.get(pullStateKey(session));
  return (row?.value as PullState | undefined) ?? { scope: null };
}

export async function getCursor(): Promise<string | undefined> {
  return (await getPullState()).cursor;
}

export async function getDefaultPriceListId(): Promise<string | null> {
  const row = await db.meta.get(DEFAULT_PRICE_LIST_KEY);
  return (row?.value as string | null | undefined) ?? null;
}

const REFERENCE_TABLES = () => [db.products, db.packagings, db.prices, db.customers, db.outlets, db.stock, db.categories, db.balances, db.routes, db.routeStops];

/** Drops all cached reference data and pull state. NEVER touches `queue`. */
export async function wipeReferenceCache(): Promise<void> {
  await db.transaction('rw', [...REFERENCE_TABLES(), db.meta], async () => {
    await Promise.all(REFERENCE_TABLES().map((t) => t.clear()));
    const keys = await db.meta.toCollection().primaryKeys();
    await db.meta.bulkDelete(keys.filter((k) => k !== CACHE_OWNER_KEY));
  });
}

/**
 * The cached catalog/customers belong to whoever pulled them. When another
 * user (or company) signs in on this device the previous user's reference data
 * is wiped (their queued documents stay encrypted in `queue`, untouched).
 * A pre-v3 cache has no recorded owner and is adopted as is.
 */
export async function ensureCacheOwner(session: OfflineSession): Promise<void> {
  const key = sessionKey(session);
  const row = await db.meta.get(CACHE_OWNER_KEY);
  if (row?.value === key) return;
  if (row) await wipeReferenceCache();
  await db.meta.put({ key: CACHE_OWNER_KEY, value: key });
}

export interface ApplyPullOptions {
  /** First page of a `fullResync` pull: rebuild customers/outlets from scratch before upserting. */
  rebuild?: boolean;
}

/**
 * Merges one `/sync/pull` page into Dexie in ONE transaction (so the cursor
 * never advances without its data): tombstones first, then idempotent
 * upserts, then scope pruning, then cursor + scope. `routes`/`routeStops`
 * arrive in full every page and are replaced wholesale. Rows are encrypted
 * before the transaction opens (Web Crypto can't be awaited inside one).
 */
export async function applyPull(result: SyncPullResult, opts: ApplyPullOptions = {}): Promise<void> {
  const session = getOfflineSession();
  const tombstones = result.tombstones ?? [];

  // Price rows are keyed [priceListId+productId]; a tombstone without entityKey is resolved by the row's own id.
  const priceIdTombstones = tombstones.filter((t) => t.entity === 'PriceListItem' && !t.entityKey).map((t) => t.entityId);
  const priceKeysById: [string, string][] = [];
  if (priceIdTombstones.length > 0) {
    const wanted = new Set(priceIdTombstones);
    for (const p of await prices.toArray()) if (wanted.has(p.id)) priceKeysById.push([p.priceListId, p.productId]);
  }

  const [pRows, pkRows, prRows, cRows, oRows, sRows, catRows, bRows, routeRows, routeStopRows] = await Promise.all([
    products.encodeRows(result.products),
    packagings.encodeRows(result.packagings),
    prices.encodeRows(result.prices),
    customers.encodeRows(result.customers),
    outlets.encodeRows(result.outlets),
    stock.encodeRows(result.stock),
    categories.encodeRows(result.categories),
    balances.encodeRows(result.balances),
    routes.encodeRows(result.routes),
    routeStops.encodeRows(result.routeStops),
  ]);

  const tables = [...REFERENCE_TABLES(), db.meta];
  await db.transaction('rw', tables, async () => {
    if (opts.rebuild) {
      await Promise.all([db.customers.clear(), db.outlets.clear()]);
    }

    // 1. tombstones
    const del = {
      products: new Set<string>(),
      packagings: [] as string[],
      prices: [...priceKeysById],
      customers: new Set<string>(),
      outlets: [] as string[],
      stock: [] as [string, string][],
      categories: [] as string[],
    };
    for (const t of tombstones) {
      switch (t.entity) {
        case 'Product':
          del.products.add(t.entityId);
          break;
        case 'ProductPackaging':
          del.packagings.push(t.entityId);
          break;
        case 'PriceListItem':
          if (t.entityKey?.priceListId && t.entityKey.productId) del.prices.push([t.entityKey.priceListId, t.entityKey.productId]);
          break;
        case 'Customer':
          del.customers.add(t.entityId);
          break;
        case 'Outlet':
          del.outlets.push(t.entityId);
          break;
        case 'StockLevel': {
          const [pid, wid] = t.entityKey ? [t.entityKey.productId, t.entityKey.warehouseId] : t.entityId.split(':');
          if (pid && wid) del.stock.push([pid, wid]);
          break;
        }
        case 'ProductCategory':
          del.categories.push(t.entityId);
          break;
      }
    }
    if (del.products.size > 0) {
      const ids = [...del.products];
      const [pk, prk, sk] = await Promise.all([
        db.packagings.where('productId').anyOf(ids).primaryKeys(),
        db.prices.where('productId').anyOf(ids).primaryKeys(),
        db.stock.where('productId').anyOf(ids).primaryKeys(),
      ]);
      await Promise.all([db.packagings.bulkDelete(pk), db.prices.bulkDelete(prk), db.stock.bulkDelete(sk), db.products.bulkDelete(ids)]);
    }
    if (del.customers.size > 0) {
      const ids = [...del.customers];
      const ok = await db.outlets.where('customerId').anyOf(ids).primaryKeys();
      await Promise.all([db.outlets.bulkDelete(ok), db.balances.bulkDelete(ids), db.customers.bulkDelete(ids)]);
    }
    await Promise.all([
      db.packagings.bulkDelete(del.packagings),
      db.prices.bulkDelete(del.prices),
      db.outlets.bulkDelete(del.outlets),
      db.stock.bulkDelete(del.stock),
      db.categories.bulkDelete(del.categories),
    ]);

    // 2. idempotent upserts
    await Promise.all([
      products.bulkPutRows(pRows),
      packagings.bulkPutRows(pkRows),
      prices.bulkPutRows(prRows),
      customers.bulkPutRows(cRows),
      outlets.bulkPutRows(oRows),
      stock.bulkPutRows(sRows),
      categories.bulkPutRows(catRows),
      balances.bulkPutRows(bRows),
    ]);

    // 3. agent scope: anything not in the server's scope lists goes (queued documents are untouched)
    if (result.scope) {
      const customerScope = new Set(result.scope.customerIds);
      const outletScope = new Set(result.scope.outletIds);
      const [cKeys, oKeys] = await Promise.all([db.customers.toCollection().primaryKeys(), db.outlets.toCollection().primaryKeys()]);
      const dropCustomers = cKeys.filter((k) => !customerScope.has(k));
      const dropOutlets = oKeys.filter((k) => !outletScope.has(k));
      await Promise.all([db.customers.bulkDelete(dropCustomers), db.balances.bulkDelete(dropCustomers), db.outlets.bulkDelete(dropOutlets)]);
    }

    // 4. routes snapshot
    await db.routes.clear();
    await db.routeStops.clear();
    await routes.bulkPutRows(routeRows);
    await routeStops.bulkPutRows(routeStopRows);

    // 5. cursor exactly as returned + scope, per user
    await db.meta.put({ key: DEFAULT_PRICE_LIST_KEY, value: result.defaultPriceListId });
    if (session) {
      const state: PullState = { cursor: result.cursor, scope: result.scope };
      await db.meta.put({ key: pullStateKey(session), value: state });
    }
  });
}

export const offlineRepository = {
  products,
  packagings,
  prices,
  customers,
  outlets,
  stock,
  categories,
  balances,
  routes,
  routeStops,
};

export type { RawRow };
