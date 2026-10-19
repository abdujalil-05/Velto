import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_POOL_SIZE,
  DEFAULT_POOL_TIMEOUT_S,
  DEFAULT_SYSTEM_POOL_SIZE,
  pooledUrl,
  resolvePoolSettings,
  withPoolParams,
} from '../pool-config';

const BASE = 'postgresql://velto_app:p%40ss@localhost:5433/velto_dev';
const S = { connectionLimit: 30, poolTimeoutS: 10 };

describe('pool-config: withPoolParams (F7 pool sizing)', () => {
  it('appends both params to a URL with an existing query', () => {
    expect(withPoolParams(`${BASE}?schema=public`, S)).toBe(`${BASE}?schema=public&connection_limit=30&pool_timeout=10`);
  });

  it('adds a query string when the URL has none, keeping encoded credentials intact', () => {
    expect(withPoolParams(BASE, S)).toBe(`${BASE}?connection_limit=30&pool_timeout=10`);
  });

  it('never overrides params already in the URL', () => {
    const url = `${BASE}?schema=public&connection_limit=40&pool_timeout=3`;
    expect(withPoolParams(url, S)).toBe(url);
    expect(withPoolParams(`${BASE}?connection_limit=40`, S)).toBe(`${BASE}?connection_limit=40&pool_timeout=10`);
    expect(withPoolParams(`${BASE}?pool_timeout=3`, S)).toBe(`${BASE}?pool_timeout=3&connection_limit=30`);
  });

  it('pooledUrl leaves an unset URL unset', () => {
    expect(pooledUrl(undefined, {}, 'app')).toBeUndefined();
    expect(pooledUrl('', {}, 'system')).toBeUndefined();
  });
});

describe('pool-config: resolvePoolSettings', () => {
  it('uses separate defaults for app and system pools', () => {
    expect(resolvePoolSettings({}, 'app')).toEqual({ connectionLimit: DEFAULT_APP_POOL_SIZE, poolTimeoutS: DEFAULT_POOL_TIMEOUT_S });
    expect(resolvePoolSettings({}, 'system')).toEqual({ connectionLimit: DEFAULT_SYSTEM_POOL_SIZE, poolTimeoutS: DEFAULT_POOL_TIMEOUT_S });
  });

  it('reads PRISMA_POOL_SIZE / PRISMA_SYSTEM_POOL_SIZE / PRISMA_POOL_TIMEOUT_S', () => {
    const env = { PRISMA_POOL_SIZE: '40', PRISMA_SYSTEM_POOL_SIZE: '4', PRISMA_POOL_TIMEOUT_S: '15' };
    expect(resolvePoolSettings(env, 'app')).toEqual({ connectionLimit: 40, poolTimeoutS: 15 });
    expect(resolvePoolSettings(env, 'system')).toEqual({ connectionLimit: 4, poolTimeoutS: 15 });
  });

  it('treats an empty value as unset', () => {
    expect(resolvePoolSettings({ PRISMA_POOL_SIZE: ' ' }, 'app').connectionLimit).toBe(DEFAULT_APP_POOL_SIZE);
  });

  it.each(['0', '-1', '2.5', 'abc', '96', '1e2'])('rejects PRISMA_POOL_SIZE=%s', (v) => {
    expect(() => resolvePoolSettings({ PRISMA_POOL_SIZE: v }, 'app')).toThrow(/PRISMA_POOL_SIZE/);
  });

  it.each(['0', '121', 'x'])('rejects PRISMA_POOL_TIMEOUT_S=%s', (v) => {
    expect(() => resolvePoolSettings({ PRISMA_POOL_TIMEOUT_S: v }, 'system')).toThrow(/PRISMA_POOL_TIMEOUT_S/);
  });
});
