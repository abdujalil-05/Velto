import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { offlineRepository } from './repository';
import { queueRepository } from './queue';
import { enforceStorageBudget } from './storage-budget';

function mockUsage(bytes: number | null): void {
  Object.defineProperty(navigator, 'storage', {
    value: bytes === null ? undefined : { estimate: async () => ({ usage: bytes, quota: 1024 ** 4 }) },
    configurable: true,
  });
}

const UNDER_BUDGET = 10 * 1024 * 1024; // 10MB
const OVER_BUDGET = 60 * 1024 * 1024; // 60MB — over the 50MB cap (10.2)

describe('enforceStorageBudget (10.2: "50 MB ... eski ma\'lumot tozalanadi")', () => {
  beforeEach(async () => {
    await db.transaction(
      'rw',
      [db.products, db.packagings, db.prices, db.stock, db.customers, db.outlets, db.balances, db.queue],
      async () => {
        await Promise.all([
          db.products.clear(),
          db.packagings.clear(),
          db.prices.clear(),
          db.stock.clear(),
          db.customers.clear(),
          db.outlets.clear(),
          db.balances.clear(),
          db.queue.clear(),
        ]);
      },
    );
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
  });

  it('does nothing when usage is under the 50MB cap', async () => {
    mockUsage(UNDER_BUDGET);
    await offlineRepository.products.bulkPut([
      { id: 'p1', categoryId: null, sku: 'P1', barcode: null, name: 'Inactive', brand: null, baseUnit: 'dona', vatRate: '12', minPrice: null, imageUrl: null, isActive: false },
    ]);

    const result = await enforceStorageBudget();

    expect(result).toBeNull();
    expect(await offlineRepository.products.count()).toBe(1);
  });

  it('does nothing when the Storage API is unavailable (treats unknown usage as under budget)', async () => {
    mockUsage(null);
    const result = await enforceStorageBudget();
    expect(result).toBeNull();
  });

  it('evicts inactive products (and their packagings/prices/stock) but keeps active ones, when over budget', async () => {
    mockUsage(OVER_BUDGET);
    await offlineRepository.products.bulkPut([
      { id: 'active-1', categoryId: null, sku: 'A1', barcode: null, name: 'Active', brand: null, baseUnit: 'dona', vatRate: '12', minPrice: null, imageUrl: null, isActive: true },
      { id: 'inactive-1', categoryId: null, sku: 'I1', barcode: null, name: 'Discontinued', brand: null, baseUnit: 'dona', vatRate: '12', minPrice: null, imageUrl: null, isActive: false },
    ]);
    await offlineRepository.packagings.bulkPut([
      { id: 'pk-active', productId: 'active-1', name: 'dona', qtyInBaseUnit: '1', isDefault: true },
      { id: 'pk-inactive', productId: 'inactive-1', name: 'dona', qtyInBaseUnit: '1', isDefault: true },
    ]);
    await offlineRepository.prices.bulkPut([
      { id: 'pr-active', priceListId: 'pl1', productId: 'active-1', price: '1000' },
      { id: 'pr-inactive', priceListId: 'pl1', productId: 'inactive-1', price: '2000' },
    ]);
    await offlineRepository.stock.bulkPut([
      { productId: 'active-1', warehouseId: 'w1', onHand: '10', reserved: '0' },
      { productId: 'inactive-1', warehouseId: 'w1', onHand: '0', reserved: '0' },
    ]);

    const result = await enforceStorageBudget();

    expect(result).toEqual({ evictedProducts: 1, evictedCustomers: 0 });

    const remainingProducts = (await offlineRepository.products.toArray()).map((p) => p.id);
    expect(remainingProducts).toEqual(['active-1']);

    const remainingPackagings = (await offlineRepository.packagings.toArray()).map((p) => p.productId);
    expect(remainingPackagings).toEqual(['active-1']);

    const remainingPrices = (await offlineRepository.prices.toArray()).map((p) => p.productId);
    expect(remainingPrices).toEqual(['active-1']);

    const remainingStock = (await offlineRepository.stock.toArray()).map((s) => s.productId);
    expect(remainingStock).toEqual(['active-1']);
  });

  it('evicts inactive customers (and their outlets/balances) but keeps active ones, when over budget', async () => {
    mockUsage(OVER_BUDGET);
    await offlineRepository.customers.bulkPut([
      { id: 'cust-active', code: 'CA', name: 'Active Co', phone: null, priceListId: null, paymentTermDays: 0, isBlocked: false, cachedBalance: '0', isActive: true },
      { id: 'cust-inactive', code: 'CI', name: 'Closed Co', phone: null, priceListId: null, paymentTermDays: 0, isBlocked: false, cachedBalance: '0', isActive: false },
    ]);
    await offlineRepository.outlets.bulkPut([
      { id: 'o1', customerId: 'cust-active', name: 'Shop A', type: 'SHOP', address: null, latitude: null, longitude: null, isActive: true },
      { id: 'o2', customerId: 'cust-inactive', name: 'Shop B', type: 'SHOP', address: null, latitude: null, longitude: null, isActive: false },
    ]);
    await offlineRepository.balances.bulkPut([
      { customerId: 'cust-active', balance: '0', updatedAt: new Date().toISOString() },
      { customerId: 'cust-inactive', balance: '0', updatedAt: new Date().toISOString() },
    ]);

    const result = await enforceStorageBudget();

    expect(result).toEqual({ evictedProducts: 0, evictedCustomers: 1 });
    expect((await offlineRepository.customers.toArray()).map((c) => c.id)).toEqual(['cust-active']);
    expect((await offlineRepository.outlets.toArray()).map((o) => o.customerId)).toEqual(['cust-active']);
    expect((await offlineRepository.balances.toArray()).map((b) => b.customerId)).toEqual(['cust-active']);
  });

  it('never touches the queue table, even when PENDING rows are old', async () => {
    mockUsage(OVER_BUDGET);
    const pendingId = await queueRepository.enqueue('order', {});

    await enforceStorageBudget();

    const all = await queueRepository.listAll();
    expect(all.map((e) => e.clientId)).toContain(pendingId);
  });

  it('is a no-op vs. a fresh estimate() call when nothing is inactive, even over budget', async () => {
    mockUsage(OVER_BUDGET);
    const estimateSpy = vi.spyOn(navigator.storage, 'estimate');
    await offlineRepository.products.bulkPut([
      { id: 'active-only', categoryId: null, sku: 'A', barcode: null, name: 'Active', brand: null, baseUnit: 'dona', vatRate: '12', minPrice: null, imageUrl: null, isActive: true },
    ]);

    const result = await enforceStorageBudget();

    expect(result).toEqual({ evictedProducts: 0, evictedCustomers: 0 });
    expect(estimateSpy).toHaveBeenCalledOnce();
    expect(await offlineRepository.products.count()).toBe(1);
  });
});
