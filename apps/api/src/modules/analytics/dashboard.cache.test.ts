import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportConcurrencyLimiter } from '../../common/concurrency/report-concurrency.limiter';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { AgingReportService } from '../finance/reports/aging-report.service';
import { DashboardService } from './dashboard.service';

/** F7.6 stale-while-revalidate semantics of the dashboard cache (pure unit: the DB queries are stubbed). */
describe('DashboardService SWR cache', () => {
  const TTL_S = 30;
  let prevTtl: string | undefined;
  let dash: DashboardService;
  let compute: ReturnType<typeof vi.fn>;

  const deferred = () => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const get = () => dash.getDashboard() as unknown as Promise<{ v: number; cached: boolean; generatedAt: string }>;
  const advance = (s: number) => vi.setSystemTime(Date.now() + s * 1000);
  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    prevTtl = process.env.DASHBOARD_CACHE_TTL_S;
    process.env.DASHBOARD_CACHE_TTL_S = String(TTL_S);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T07:00:00Z'));
    const tenantPrisma = { companyId: '00000000-0000-4000-8000-000000000001', run: async () => 'Asia/Tashkent' };
    dash = new DashboardService(tenantPrisma as unknown as TenantPrismaService, {} as AgingReportService, new ReportConcurrencyLimiter());
    compute = vi.fn();
    vi.spyOn(dash as unknown as { computeQueries: () => Promise<unknown> }, 'computeQueries').mockImplementation(compute);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevTtl === undefined) delete process.env.DASHBOARD_CACHE_TTL_S;
    else process.env.DASHBOARD_CACHE_TTL_S = prevTtl;
  });

  it('single-flight: concurrent first calls share one compute and all wait (cached:false)', async () => {
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    const calls = Array.from({ length: 5 }, () => get());
    await flush();
    d.resolve({ v: 1 });
    const results = await Promise.all(calls);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.v === 1 && r.cached === false)).toBe(true);
    expect(new Set(results.map((r) => r.generatedAt)).size).toBe(1);
    expect(await get()).toMatchObject({ v: 1, cached: true });
  });

  it('in-flight refresh serves the last completed value; the trigger waits for the new one', async () => {
    compute.mockResolvedValueOnce({ v: 1 });
    await get();
    advance(TTL_S + 1);
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    const trigger = get();
    await flush();
    const stale = await get();
    expect(stale).toMatchObject({ v: 1, cached: true });
    d.resolve({ v: 2 });
    expect(await trigger).toMatchObject({ v: 2, cached: false });
    expect(await get()).toMatchObject({ v: 2, cached: true });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('a new key (new company day) has no completed value: callers wait and get cached:false', async () => {
    compute.mockResolvedValueOnce({ v: 1 });
    await get();
    advance(24 * 3600);
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    const a = get();
    await flush();
    const b = get();
    await flush();
    d.resolve({ v: 2 });
    expect(await a).toMatchObject({ v: 2, cached: false });
    expect(await b).toMatchObject({ v: 2, cached: false });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('a value older than 2xTTL is never served stale: callers join the refresh', async () => {
    compute.mockResolvedValueOnce({ v: 1 });
    await get();
    advance(2 * TTL_S + 1);
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    const a = get();
    await flush();
    const b = get();
    await flush();
    d.resolve({ v: 2 });
    expect(await b).toMatchObject({ v: 2, cached: false });
    expect(await a).toMatchObject({ v: 2, cached: false });
  });

  it('a failed refresh keeps the old value; the error reaches only the waiting trigger', async () => {
    compute.mockResolvedValueOnce({ v: 1 });
    const first = await get();
    advance(TTL_S + 1);
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    const trigger = get();
    await flush();
    const stale = get();
    d.reject(new Error('boom'));
    await expect(trigger).rejects.toThrow('boom');
    expect(await stale).toMatchObject({ v: 1, cached: true, generatedAt: first.generatedAt });
    // Old value not poisoned: next caller starts a new refresh and gets fresh data.
    compute.mockResolvedValueOnce({ v: 3 });
    expect(await get()).toMatchObject({ v: 3, cached: false });
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('a failed first refresh leaves no entry: the next call recomputes', async () => {
    compute.mockRejectedValueOnce(new Error('boom'));
    await expect(get()).rejects.toThrow('boom');
    compute.mockResolvedValueOnce({ v: 1 });
    expect(await get()).toMatchObject({ v: 1, cached: false });
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
