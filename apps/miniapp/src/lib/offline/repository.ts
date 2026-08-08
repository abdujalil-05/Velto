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
  SyncStock,
} from '@/lib/api/sync';
import { db, type RawRow } from './db';
import { EncryptedStore } from './encrypted-store';

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

const CURSOR_KEY = 'cursor';
const DEFAULT_PRICE_LIST_KEY = 'defaultPriceListId';

export async function getCursor(): Promise<string | undefined> {
  const row = await db.meta.get(CURSOR_KEY);
  return row?.value as string | undefined;
}

async function setCursor(cursor: string): Promise<void> {
  await db.meta.put({ key: CURSOR_KEY, value: cursor });
}

export async function getDefaultPriceListId(): Promise<string | null> {
  const row = await db.meta.get(DEFAULT_PRICE_LIST_KEY);
  return (row?.value as string | null | undefined) ?? null;
}

async function setDefaultPriceListId(id: string | null): Promise<void> {
  await db.meta.put({ key: DEFAULT_PRICE_LIST_KEY, value: id });
}

/** Merges one `/sync/pull` response into Dexie. `routes`/`routeStops` are a full snapshot every pull (10.1 — matches the backend, which never deletes locally via a delta signal), so they're replaced wholesale rather than upserted. */
export async function applyPull(result: SyncPullResult): Promise<void> {
  await Promise.all([
    products.bulkPut(result.products),
    packagings.bulkPut(result.packagings),
    prices.bulkPut(result.prices),
    customers.bulkPut(result.customers),
    outlets.bulkPut(result.outlets),
    stock.bulkPut(result.stock),
    categories.bulkPut(result.categories),
    balances.bulkPut(result.balances),
  ]);

  await db.routes.clear();
  await db.routeStops.clear();
  await routes.bulkPut(result.routes);
  await routeStops.bulkPut(result.routeStops);

  await setCursor(result.cursor);
  await setDefaultPriceListId(result.defaultPriceListId);
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
