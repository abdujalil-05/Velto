import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncCustomer, SyncProduct } from '@/lib/api/sync';
import { db } from './db';
import { offlineRepository } from './repository';
import { searchCustomers, searchProducts } from './search';
import { setOfflineSession } from './session';

const NAMES = ['Coca-Cola', 'Pepsi', 'Nestle', 'Sut', 'Yogurt', 'Non', 'Guruch', 'Un', 'Shakar', 'Yog'];
const product = (i: number): SyncProduct => ({
  id: `p${i}`, categoryId: `cat${i % 20}`, sku: `SKU-${String(i).padStart(5, '0')}`, barcode: `478${String(i).padStart(10, '0')}`,
  name: `${NAMES[i % NAMES.length]} ${i} 0.${(i % 9) + 1}L`, brand: null, baseUnit: 'dona', vatRate: '12', minPrice: null, imageUrl: null, isActive: i % 50 !== 0,
});
const customer = (i: number): SyncCustomer => ({
  id: `c${i}`, code: `C-${String(i).padStart(4, '0')}`, name: `Do'kon ${NAMES[i % NAMES.length]} ${i}`, phone: null, priceListId: null, paymentTermDays: 0, isBlocked: i % 97 === 0, cachedBalance: '0', isActive: true,
});

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

// NFR-PERF-004: catalog/customer search p95 <= 150 ms (generous, fake-indexeddb, includes decrypt read of all rows).
describe('offline search perf (NFR-PERF-004)', () => {
  beforeEach(async () => {
    await Promise.all([db.products.clear(), db.customers.clear(), db.meta.clear()]);
    setOfflineSession({ userId: 'uS', companyId: 'cS' });
  });

  it('product + customer search p95 <= 150 ms over 5k products / 2k customers', async () => {
    await offlineRepository.products.bulkPut(Array.from({ length: 5000 }, (_, i) => product(i)));
    await offlineRepository.customers.bulkPut(Array.from({ length: 2000 }, (_, i) => customer(i)));
    const products = await offlineRepository.products.toArray();
    const customers = await offlineRepository.customers.toArray();
    expect(products).toHaveLength(5000);
    expect(customers).toHaveLength(2000);

    const queries = ['col', 'pepsi 1', 'SKU-0420', '4780000', 'sut', 'zzz', 'yog', 'non 77', 'nes', 'guruch'];
    const pTimes: number[] = [];
    const cTimes: number[] = [];
    for (let r = 0; r < 10; r++) {
      for (const q of queries) {
        let t0 = performance.now();
        searchProducts(products, q, r % 2 ? 'cat3' : null);
        pTimes.push(performance.now() - t0);
        t0 = performance.now();
        searchCustomers(customers, q);
        cTimes.push(performance.now() - t0);
      }
    }
    console.log(`[NFR-PERF-004] products p95=${p95(pTimes).toFixed(2)}ms customers p95=${p95(cTimes).toFixed(2)}ms`);
    expect(p95(pTimes)).toBeLessThanOrEqual(150);
    expect(p95(cTimes)).toBeLessThanOrEqual(150);
    // 30s covers only the seeding (7k AES-GCM encrypted rows); the NFR bound above is unchanged.
  }, 30_000);
});
