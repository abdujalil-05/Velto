import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ReportBusyException, ReportConcurrencyLimiter } from '../../common/concurrency/report-concurrency.limiter';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { AgingReportService } from '../finance/reports/aging-report.service';
import { DashboardService } from './dashboard.service';

/** F7.6 stale-while-revalidate semantics of the dashboard cache (pure unit: the DB queries are stubbed). */
describe('DashboardService SWR cache', () => {
  const TTL_S = 30;
  const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
  const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
  let prevTtl: string | undefined;
  let tenantPrisma: { companyId: string; run: () => Promise<string> };
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
  const make = (limiter = new ReportConcurrencyLimiter()) => {
    dash = new DashboardService(tenantPrisma as unknown as TenantPrismaService, {} as AgingReportService, limiter);
    compute = vi.fn();
    vi.spyOn(dash as unknown as { computeQueries: () => Promise<unknown> }, 'computeQueries').mockImplementation(compute);
  };

  beforeEach(() => {
    prevTtl = process.env.DASHBOARD_CACHE_TTL_S;
    process.env.DASHBOARD_CACHE_TTL_S = String(TTL_S);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T07:00:00Z'));
    tenantPrisma = { companyId: COMPANY_A, run: async () => 'Asia/Tashkent' };
    make();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(await get()).toMatchObject({ v: 1, cached: true });
  });

  it('first call after TTL returns the stale value (cached:true) and starts one background compute', async () => {
    compute.mockResolvedValueOnce({ v: 1 });
    await get();
    advance(TTL_S + 1);
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    expect(await get()).toMatchObject({ v: 1, cached: true });
    await flush();
    expect(compute).toHaveBeenCalledTimes(2);
    d.resolve({ v: 2 });
    await flush();
    expect(await get()).toMatchObject({ v: 2, cached: true });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('10 parallel calls after TTL all get stale and trigger exactly one compute', async () => {
    compute.mockResolvedValueOnce({ v: 1 });
    await get();
    advance(TTL_S + 1);
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    const results = await Promise.all(Array.from({ length: 10 }, () => get()));
    expect(results.every((r) => r.v === 1 && r.cached === true)).toBe(true);
    await flush();
    expect(compute).toHaveBeenCalledTimes(2);
    d.resolve({ v: 2 });
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

  it('a value older than 2xTTL is never served stale: callers join the compute', async () => {
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
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('a failed background refresh is logged, keeps the stale value and starts no compute within the backoff', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    compute.mockResolvedValueOnce({ v: 1 });
    const first = await get();
    advance(TTL_S + 1);
    compute.mockRejectedValueOnce(new Error('boom'));
    expect(await get()).toMatchObject({ v: 1, cached: true, generatedAt: first.generatedAt });
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await get()).toMatchObject({ v: 1, cached: true, generatedAt: first.generatedAt });
    await flush();
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('after the backoff a background refresh runs again (stale served) and its success clears the failure mark', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    compute.mockResolvedValueOnce({ v: 1 });
    const first = await get();
    advance(TTL_S + 1);
    compute.mockRejectedValueOnce(new Error('boom'));
    await get();
    await flush();
    advance(TTL_S / 4);
    compute.mockResolvedValueOnce({ v: 3 });
    expect(await get()).toMatchObject({ v: 1, cached: true, generatedAt: first.generatedAt });
    await flush();
    expect(compute).toHaveBeenCalledTimes(3);
    expect(await get()).toMatchObject({ v: 3, cached: true });
    advance(TTL_S + 1);
    compute.mockResolvedValueOnce({ v: 4 });
    expect(await get()).toMatchObject({ v: 3, cached: true });
    await flush();
    expect(await get()).toMatchObject({ v: 4, cached: true });
    expect(compute).toHaveBeenCalledTimes(4);
  });

  it('a failed first compute leaves no entry: the next call recomputes', async () => {
    compute.mockRejectedValueOnce(new Error('boom'));
    await expect(get()).rejects.toThrow('boom');
    compute.mockResolvedValueOnce({ v: 1 });
    expect(await get()).toMatchObject({ v: 1, cached: false });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('busy dashboard lane: stale value is served, a cold caller gets ReportBusyException', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const lane = new ReportConcurrencyLimiter({ maxConcurrency: 1, tenantMaxConcurrency: 1, queueMax: 0, tenantQueueMax: 0, queueTimeoutMs: 100 });
    make(lane);
    compute.mockResolvedValueOnce({ v: 1 });
    await get();
    const hold = await lane.acquire(undefined, COMPANY_B);
    advance(TTL_S + 1);
    expect(await get()).toMatchObject({ v: 1, cached: true });
    await flush();
    advance(24 * 3600);
    await expect(get()).rejects.toBeInstanceOf(ReportBusyException);
    hold();
  });

  it('heavy-report permits being busy does not block the dashboard permit', async () => {
    const heavy = new ReportConcurrencyLimiter({ maxConcurrency: 1, tenantMaxConcurrency: 1, queueMax: 0, tenantQueueMax: 0, queueTimeoutMs: 100 });
    const hold = await heavy.acquire(undefined, COMPANY_A);
    compute.mockResolvedValueOnce({ v: 1 });
    expect(await get()).toMatchObject({ v: 1, cached: false });
    await expect(heavy.acquire(undefined, COMPANY_A)).rejects.toBeInstanceOf(ReportBusyException);
    hold();
  });

  it('logs one structured line per compute with permitWaitMs, poolWaitMs, computeMs and mode', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    compute.mockImplementationOnce(async (_c: string, _tz: string, onPoolWait: (ms: number) => void) => {
      onPoolWait(7);
      onPoolWait(42);
      onPoolWait(3);
      return { v: 1 };
    });
    await get();
    advance(TTL_S + 1);
    compute.mockResolvedValueOnce({ v: 2 });
    await get();
    await flush();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toMatchObject({ mode: 'cold', poolWaitMs: 42, permitWaitMs: expect.any(Number), computeMs: expect.any(Number) });
    expect(log.mock.calls[1]![0]).toMatchObject({ mode: 'refresh', poolWaitMs: 0 });
  });

  it('a refresh for tenant A computes for A even when the "current" tenant is B, and never fills B', async () => {
    compute.mockResolvedValueOnce({ v: 1 });
    await get();
    advance(TTL_S + 1);
    const d = deferred();
    compute.mockReturnValueOnce(d.promise);
    await get();
    await flush();
    tenantPrisma.companyId = COMPANY_B;
    d.resolve({ v: 2 });
    await flush();
    expect(compute.mock.calls.map((c) => c[0])).toEqual([COMPANY_A, COMPANY_A]);
    compute.mockResolvedValueOnce({ v: 9 });
    expect(await get()).toMatchObject({ v: 9, cached: false });
    expect(compute.mock.calls[2]![0]).toBe(COMPANY_B);
  });
});
