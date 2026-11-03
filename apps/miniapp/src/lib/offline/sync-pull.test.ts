import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncPullResult } from '@/lib/api/sync';
import { db } from './db';
import { queueRepository, QueueQuotaError } from './queue';
import { offlineRepository, getCursor, getPullState } from './repository';
import { setOfflineSession } from './session';
import { readyVault } from './vault-test-helper';
import { resetPreparedSession } from './session-bootstrap';
import { enforceStorageBudget, onStorageStatus, publishStorageStatus, storageStatusFor } from './storage-budget';

const pullSync = vi.fn();
vi.mock('@/lib/api/sync', () => ({ pullSync: (...a: unknown[]) => pullSync(...a), pushSync: vi.fn() }));

import { runPull } from './sync-engine-core';

function page(over: Partial<SyncPullResult> = {}): SyncPullResult {
  return {
    cursor: 'c1', hasMore: false, fullResync: false,
    products: [], packagings: [], prices: [], customers: [], outlets: [], stock: [], categories: [], balances: [],
    tombstones: [], routes: [], routeStops: [], defaultPriceListId: null, scope: null,
    ...over,
  };
}
const product = (id: string) => ({ id, categoryId: null, sku: id, barcode: null, name: id, brand: null, baseUnit: 'dona', vatRate: '12', minPrice: null, imageUrl: null, isActive: true });
const customer = (id: string) => ({ id, code: id, name: id, phone: null, priceListId: null, paymentTermDays: 0, isBlocked: false, cachedBalance: '0', isActive: true });
const outlet = (id: string, customerId: string) => ({ id, customerId, name: id, type: 'SHOP', address: null, latitude: null, longitude: null, isActive: true });
const tomb = (entity: string, entityId: string, entityKey: Record<string, string> | null = null) =>
  ({ entity, entityId, entityKey, deletedAt: '2026-10-13T00:00:00Z', changeSeq: '5' }) as SyncPullResult['tombstones'][number];

async function reset() {
  vi.clearAllMocks();
  await Promise.all([...[db.products, db.packagings, db.prices, db.customers, db.outlets, db.stock, db.categories, db.balances, db.routes, db.routeStops, db.queue, db.meta].map((t) => t.clear())]);
  setOfflineSession({ userId: 'u1', companyId: 'c1' });
  await readyVault({ userId: 'u1', companyId: 'c1' });
  resetPreparedSession();
}

describe('pull applier', () => {
  beforeEach(reset);

  it('tombstones delete product (cascading), price, packaging, customer (cascading) and stock', async () => {
    pullSync.mockResolvedValueOnce(page({
      products: [product('p1'), product('p2')],
      packagings: [{ id: 'k1', productId: 'p1', name: 'box', qtyInBaseUnit: '1', isDefault: true }, { id: 'k2', productId: 'p2', name: 'box', qtyInBaseUnit: '1', isDefault: true }],
      prices: [{ id: 'x1', priceListId: 'L', productId: 'p1', price: '1' }, { id: 'x2', priceListId: 'L', productId: 'p2', price: '2' }, { id: 'x3', priceListId: 'L', productId: 'p3', price: '3' }],
      stock: [{ productId: 'p2', warehouseId: 'w', onHand: '1', reserved: '0' }],
      customers: [customer('c1'), customer('c2')],
      outlets: [outlet('o1', 'c1'), outlet('o2', 'c2')],
      balances: [{ customerId: 'c1', balance: '1', updatedAt: 'x' }],
      cursor: 'a',
    }));
    await runPull();
    pullSync.mockResolvedValueOnce(page({
      cursor: 'b',
      tombstones: [
        tomb('Product', 'p1'),
        tomb('ProductPackaging', 'k2'),
        tomb('PriceListItem', 'x2', { priceListId: 'L', productId: 'p2' }),
        tomb('PriceListItem', 'x3'), // no entityKey -> resolved by row id
        tomb('StockLevel', 'p2:w', { productId: 'p2', warehouseId: 'w' }),
        tomb('Customer', 'c1'),
        tomb('Outlet', 'o2'),
      ],
    }));
    await runPull();
    expect((await offlineRepository.products.toArray()).map((p) => p.id)).toEqual(['p2']);
    expect(await offlineRepository.packagings.count()).toBe(0);
    expect(await offlineRepository.prices.count()).toBe(0);
    expect(await offlineRepository.stock.count()).toBe(0);
    expect((await offlineRepository.customers.toArray()).map((c) => c.id)).toEqual(['c2']);
    expect(await offlineRepository.outlets.count()).toBe(0);
    expect(await offlineRepository.balances.count()).toBe(0);
  });

  it('tombstones apply before upserts, so a re-created row survives', async () => {
    pullSync.mockResolvedValueOnce(page({ products: [product('p1')], tombstones: [tomb('Product', 'p1')] }));
    await runPull();
    expect(await offlineRepository.products.count()).toBe(1);
  });

  it('hasMore loops with the returned cursor; cursor stored exactly as returned (even if lower)', async () => {
    pullSync
      .mockResolvedValueOnce(page({ cursor: '900', hasMore: true, products: [product('p1')] }))
      .mockResolvedValueOnce(page({ cursor: '850', hasMore: false, products: [product('p1'), product('p2')] }));
    const { pages } = await runPull();
    expect(pages).toBe(2);
    expect(pullSync.mock.calls.map((c) => c[0])).toEqual([undefined, '900']);
    expect(await getCursor()).toBe('850');
    expect(await offlineRepository.products.count()).toBe(2); // idempotent upsert of the resent window
    // survives "restart": next pull starts from the stored cursor
    pullSync.mockResolvedValueOnce(page({ cursor: '860' }));
    await runPull();
    expect(pullSync.mock.calls[2]?.[0]).toBe('850');
  });

  it('cursor + scope are per user', async () => {
    pullSync.mockResolvedValueOnce(page({ cursor: 'A', scope: { customerIds: [], outletIds: [] } }));
    await runPull();
    setOfflineSession({ userId: 'u2', companyId: 'c1' });
    resetPreparedSession();
    expect(await getCursor()).toBeUndefined();
    setOfflineSession({ userId: 'u1', companyId: 'c1' });
    expect((await getPullState()).cursor).toBe('A');
  });

  it('fullResync rebuilds customers/outlets once (first page only)', async () => {
    pullSync.mockResolvedValueOnce(page({ customers: [customer('old')], outlets: [outlet('oldo', 'old')], cursor: 'x' }));
    await runPull();
    pullSync
      .mockResolvedValueOnce(page({ fullResync: true, hasMore: true, cursor: 'y', customers: [customer('n1')], outlets: [outlet('n1o', 'n1')] }))
      .mockResolvedValueOnce(page({ fullResync: true, cursor: 'z', customers: [customer('n2')] }));
    await runPull();
    expect((await offlineRepository.customers.toArray()).map((c) => c.id).sort()).toEqual(['n1', 'n2']);
    expect((await offlineRepository.outlets.toArray()).map((o) => o.id)).toEqual(['n1o']);
  });

  it('agent scope prunes customers/outlets (and balances) outside the lists; queue untouched', async () => {
    await setOfflineSession({ userId: 'u1', companyId: 'c1' });
    const queued = await queueRepository.enqueue('order', { customerId: 'gone' });
    pullSync.mockResolvedValueOnce(page({
      customers: [customer('keep'), customer('gone')],
      outlets: [outlet('ok', 'keep'), outlet('no', 'gone')],
      balances: [{ customerId: 'gone', balance: '1', updatedAt: 'x' }],
    }));
    await runPull();
    pullSync.mockResolvedValueOnce(page({ cursor: 'n', scope: { customerIds: ['keep'], outletIds: ['ok'] } }));
    await runPull();
    expect((await offlineRepository.customers.toArray()).map((c) => c.id)).toEqual(['keep']);
    expect((await offlineRepository.outlets.toArray()).map((o) => o.id)).toEqual(['ok']);
    expect(await offlineRepository.balances.count()).toBe(0);
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([queued]);
  });

  it('a different user signing in wipes the previous reference cache but keeps their queue', async () => {
    const q = await queueRepository.enqueue('order', {});
    pullSync.mockResolvedValueOnce(page({ products: [product('p1')], cursor: 'a' }));
    await runPull();
    setOfflineSession({ userId: 'u2', companyId: 'c1' });
    resetPreparedSession();
    pullSync.mockResolvedValueOnce(page({ cursor: 'b' }));
    await runPull();
    expect(await offlineRepository.products.count()).toBe(0);
    expect(await db.queue.toArray().then((r) => r.map((x) => x.clientId))).toEqual([q]); // u1's vault row stays, unreadable for u2
    expect(await queueRepository.listAll()).toEqual([]);
  });
});

describe('storage (TZ 8.4)', () => {
  beforeEach(reset);

  function mockUsage(bytes: number) {
    Object.defineProperty(navigator, 'storage', { value: { estimate: async () => ({ usage: bytes, quota: 1 << 40 }) }, configurable: true });
  }

  it('warns from 80% of the 50 MB budget', async () => {
    const MB = 1024 * 1024;
    expect(storageStatusFor(39 * MB).level).toBe('ok');
    expect(storageStatusFor(40 * MB).level).toBe('warning');
    expect(storageStatusFor(51 * MB).level).toBe('full');
    expect(storageStatusFor(null).level).toBe('unknown');
    const seen: string[] = [];
    const off = onStorageStatus((s) => seen.push(s.level));
    mockUsage(45 * MB);
    await publishStorageStatus();
    off();
    expect(seen).toEqual(['warning']);
  });

  it('QuotaExceededError on enqueue throws a typed error and loses nothing already queued', async () => {
    const existing = await queueRepository.enqueue('order', { a: 1 });
    const spy = vi.spyOn(db.queue, 'put').mockRejectedValue(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    await expect(queueRepository.enqueue('order', { b: 2 })).rejects.toBeInstanceOf(QueueQuotaError);
    spy.mockRestore();
    expect((await queueRepository.listAll()).map((e) => e.clientId)).toEqual([existing]);
  });

  it('cache cleanup over budget never deletes PENDING/CONFLICT/FAILED items', async () => {
    const p = await queueRepository.enqueue('order', {});
    const c = await queueRepository.enqueue('order', {});
    const f = await queueRepository.enqueue('order', {});
    await queueRepository.markConflict(c, { code: 'PRICE_CHANGED', message: 'x' });
    await queueRepository.markFailed(f, { code: 'X', message: 'x' });
    await offlineRepository.products.bulkPut([{ ...product('dead'), isActive: false }]);
    mockUsage(80 * 1024 * 1024);
    const res = await enforceStorageBudget();
    expect(res?.evictedProducts).toBe(1);
    await queueRepository.pruneOld();
    expect((await queueRepository.listAll()).map((e) => e.clientId).sort()).toEqual([p, c, f].sort());
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
  });
});
