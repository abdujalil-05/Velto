import { describe, expect, it } from 'vitest';
import { DATASET_KEYS, DEFAULT_STALE_HOURS, isDatasetStale, staleAfterMs } from './staleness';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const H = 3_600_000;

describe('staleness', () => {
  it('covers products, prices, customers, stock, balances and route', () => {
    expect([...DATASET_KEYS].sort()).toEqual(['balances', 'customers', 'prices', 'products', 'route', 'stock']);
  });

  it('treats never-synced and unparseable times as stale', () => {
    expect(isDatasetStale(null, 'stock', NOW)).toBe(true);
    expect(isDatasetStale('garbage', 'stock', NOW)).toBe(true);
  });

  it('compares against the per-dataset TTL', () => {
    const at = new Date(NOW - 5 * H).toISOString();
    expect(isDatasetStale(at, 'stock', NOW, 6 * H)).toBe(false);
    expect(isDatasetStale(at, 'stock', NOW, 4 * H)).toBe(true);
  });

  it('TTL is configurable, falls back to the default on missing or invalid values', () => {
    expect(staleAfterMs('stock', '6')).toBe(6 * H);
    expect(staleAfterMs('stock', undefined)).toBe(DEFAULT_STALE_HOURS * H);
    expect(staleAfterMs('stock', 'abc')).toBe(DEFAULT_STALE_HOURS * H);
    expect(staleAfterMs('stock', '0')).toBe(DEFAULT_STALE_HOURS * H);
  });
});
