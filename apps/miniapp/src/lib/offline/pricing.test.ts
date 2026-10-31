import { describe, expect, it } from 'vitest';
import { computeLineTotal, estimateOrderTotal } from './pricing';
import type { SyncPackaging, SyncPriceItem, SyncProduct } from '@/lib/api/sync';

const base = { packagingQtyInBaseUnit: '1', discountPct: 0, vatRate: 0 };

// Expected values are hand-computed (server rule: exact product, HALF_UP to 2dp per line).
const cases: Array<[string, Parameters<typeof computeLineTotal>[0], number]> = [
  // 10.004999 -> 10.00 (below tie)
  ['tie below x.xx4999', { ...base, qty: 1, price: '10.004999' }, 10],
  // 10.005 -> 10.01 (exact tie rounds up)
  ['tie exact x.xx5', { ...base, qty: 1, price: '10.005' }, 10.01],
  // 10.005001 -> 10.01
  ['tie above x.xx5001', { ...base, qty: 1, price: '10.005001' }, 10.01],
  // 1 x 0.01 = 0.01
  ['smallest price 0.01', { ...base, qty: 1, price: '0.01' }, 0.01],
  // 1 x 0.005 = 0.005 -> 0.01
  ['price 0.005', { ...base, qty: 1, price: '0.005' }, 0.01],
  // 3 x 333.335 = 1000.005 -> 1000.01 (float gave 1000.00)
  ['qty 3 x 333.335', { ...base, qty: 3, price: '333.335' }, 1000.01],
  // 1.5 x 100.01 = 150.015 -> 150.02
  ['fractional qty 1.5', { ...base, qty: 1.5, price: '100.01' }, 150.02],
  // 0.125 x 10 = 1.25
  ['fractional qty 0.125 exact', { ...base, qty: 0.125, price: '10' }, 1.25],
  // 0.125 x 0.07 = 0.00875 -> 0.01
  ['fractional qty 0.125 small', { ...base, qty: 0.125, price: '0.07' }, 0.01],
  // 100.04 x 0.875 = 87.535 -> 87.54
  ['12.5% discount tie', { ...base, qty: 1, price: '100.04', discountPct: 12.5 }, 87.54],
  // 0.99 x 1.12 = 1.1088 -> 1.11
  ['VAT 12%', { ...base, qty: 1, price: '0.99', vatRate: 12 }, 1.11],
  // 3 x 9.99 = 29.97; x0.875 = 26.22375; x1.12 = 29.3706 -> 29.37
  ['VAT 12% + discount 12.5% fractional intermediates', { ...base, qty: 3, price: '9.99', discountPct: 12.5, vatRate: 12 }, 29.37],
  // packaging 12 x qty 2 x 1.005 = 24.12 (base qty 24)
  ['packaging multiplier', { ...base, packagingQtyInBaseUnit: '12', qty: 2, price: '1.005' }, 24.12],
  // 999999999999.99 stays exact
  ['large value', { ...base, qty: 1, price: '999999999999.99' }, 999999999999.99],
];

describe('computeLineTotal', () => {
  it.each(cases)('%s', (_n, params, expected) => {
    expect(computeLineTotal(params)).toBe(expected);
  });
});

describe('estimateOrderTotal', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const vat: Record<string, string> = { e: '12' };
  const products = ids.map((id) => ({ id, vatRate: vat[id] ?? '0' })) as unknown as SyncProduct[];
  const packagings = ids.map((id) => ({ id: `p${id}`, productId: id, qtyInBaseUnit: '1' })) as unknown as SyncPackaging[];
  const px: Record<string, string> = { a: '0.005', b: '0.005', c: '333.335', d: '100.01', e: '9.99' };
  const prices = ids.map((id) => ({ productId: id, priceListId: 'L', price: px[id] })) as unknown as SyncPriceItem[];

  it('sums rounded lines without re-rounding', () => {
    const lines = [
      { productId: 'a', packagingId: 'pa', qty: 1 }, // 0.005 -> 0.01
      { productId: 'b', packagingId: 'pb', qty: 1 }, // 0.005 -> 0.01
      { productId: 'c', packagingId: 'pc', qty: 3 }, // 1000.005 -> 1000.01
      { productId: 'd', packagingId: 'pd', qty: 1.5 }, // 150.015 -> 150.02
      { productId: 'e', packagingId: 'pe', qty: 3, discountPct: 12.5 }, // 29.3706 -> 29.37
    ];
    // 0.01 + 0.01 + 1000.01 + 150.02 + 29.37 = 1179.42 (unrounded-sum would give 1179.4)
    expect(estimateOrderTotal(lines, 'L', null, products, packagings, prices)).toBe(1179.42);
  });

  it('skips unresolvable lines', () => {
    expect(estimateOrderTotal([{ productId: 'zz', packagingId: 'x', qty: 1 }], 'L', null, products, packagings, prices)).toBe(0);
  });
});
