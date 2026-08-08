import Dexie, { type Table } from 'dexie';
import type { EncryptedBlob } from './crypto';

/**
 * 10.2's `db.version(1).stores({...})` schema, reproduced field-for-field,
 * plus one addition (`categories`) the Order screen's category filter (9.4
 * Ekran 4) needs and 10.2's table doesn't literally list — mirrors the same
 * addition made to `GET /sync/pull` (apps/api/src/modules/sync/sync.service.ts).
 *
 * Every row is stored as its declared index fields in plaintext (so Dexie's
 * own indexes/queries keep working) plus the full object AES-GCM-encrypted
 * under `_enc` (crypto.ts) — see `encrypted-store.ts` for the read/write
 * wrapper that makes this transparent to callers.
 */
export interface RawRow {
  _enc: EncryptedBlob;
}

class VeltoOfflineDb extends Dexie {
  products!: Table<RawRow & { id: string; sku: string; name: string; categoryId: string | null }, string>;
  packagings!: Table<RawRow & { id: string; productId: string }, string>;
  prices!: Table<RawRow & { priceListId: string; productId: string }, [string, string]>;
  customers!: Table<RawRow & { id: string; code: string; name: string }, string>;
  outlets!: Table<RawRow & { id: string; customerId: string }, string>;
  stock!: Table<RawRow & { productId: string; warehouseId: string }, [string, string]>;
  categories!: Table<RawRow & { id: string; parentId: string | null }, string>;
  balances!: Table<RawRow & { customerId: string }, string>;
  routes!: Table<RawRow & { id: string; weekday: number }, string>;
  routeStops!: Table<RawRow & { id: string; routeId: string; outletId: string }, string>;
  queue!: Table<RawRow & { clientId: string; type: string; status: string; createdAt: string }, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('velto-miniapp');
    this.version(1).stores({
      products: 'id, sku, name, categoryId',
      packagings: 'id, productId',
      prices: '[priceListId+productId], productId',
      customers: 'id, code, name, tin',
      outlets: 'id, customerId',
      stock: '[productId+warehouseId], productId',
      categories: 'id, parentId',
      balances: 'customerId',
      routes: 'id, weekday',
      routeStops: 'id, routeId, outletId',
      queue: 'clientId, type, status, createdAt',
      meta: 'key',
    });
    // v2: INN (tin) dropped from the product — no longer synced or indexed.
    this.version(2).stores({
      customers: 'id, code, name',
    });
  }
}

export const db = new VeltoOfflineDb();

/** Logout / device-key rotation: wipes every locally cached + queued row. auth-context.tsx's logout() is the only caller and refuses to invoke this while any queue entry is unsynced — see its comment. */
export async function clearOfflineDb(): Promise<void> {
  await db.transaction(
    'rw',
    [db.products, db.packagings, db.prices, db.customers, db.outlets, db.stock, db.categories, db.balances, db.routes, db.routeStops, db.queue, db.meta],
    async () => {
      await Promise.all([
        db.products.clear(),
        db.packagings.clear(),
        db.prices.clear(),
        db.customers.clear(),
        db.outlets.clear(),
        db.stock.clear(),
        db.categories.clear(),
        db.balances.clear(),
        db.routes.clear(),
        db.routeStops.clear(),
        db.queue.clear(),
        db.meta.clear(),
      ]);
    },
  );
}
