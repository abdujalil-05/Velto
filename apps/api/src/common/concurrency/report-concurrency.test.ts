import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ReportConcurrencyGuard } from './report-concurrency.guard';
import { ReportBusyException, ReportConcurrencyLimiter } from './report-concurrency.limiter';
import { DashboardReportGuard } from '../../modules/analytics/dashboard-report.guard';
import { ReportsController } from '../../modules/analytics/reports.controller';
import { AgingReportController } from '../../modules/finance/reports/aging-report.controller';

const opts = { maxConcurrency: 2, queueMax: 3, queueTimeoutMs: 200 };
const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeCtx() {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  });
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ tokenPayload: { companyId: 'c1' } }), getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { res, ctx };
}

describe('ReportConcurrencyLimiter', () => {
  it('runs at most maxConcurrency of N+M at once; rest queue FIFO', async () => {
    const lim = new ReportConcurrencyLimiter(opts);
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    const job = async (i: number) => {
      const rel = await lim.acquire();
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      done.push(i);
      rel();
    };
    await Promise.all([0, 1, 2, 3, 4].map(job)); // 2 + 3 queued
    expect(peak).toBe(2);
    expect(done).toHaveLength(5);
    expect(lim.stats).toEqual({ active: 0, queued: 0 });
  });

  it('rejects 503 SERVICE_BUSY when the queue is full', async () => {
    const lim = new ReportConcurrencyLimiter(opts);
    const held = [await lim.acquire(), await lim.acquire()];
    const waiting = [1, 2, 3].map(() => lim.acquire().catch(() => undefined));
    await expect(lim.acquire()).rejects.toBeInstanceOf(ReportBusyException);
    held.forEach((r) => r());
    (await Promise.all(waiting)).forEach((r) => r?.());
    expect(lim.stats).toEqual({ active: 0, queued: 0 });
  });

  it('queue wait timeout -> 503 and leaves the queue', async () => {
    const lim = new ReportConcurrencyLimiter({ ...opts, queueTimeoutMs: 20 });
    const held = [await lim.acquire(), await lim.acquire()];
    await expect(lim.acquire()).rejects.toBeInstanceOf(ReportBusyException);
    expect(lim.stats.queued).toBe(0);
    held.forEach((r) => r());
    expect(lim.stats.active).toBe(0);
  });

  it('release is idempotent', async () => {
    const lim = new ReportConcurrencyLimiter(opts);
    const r = await lim.acquire();
    r();
    r();
    expect(lim.stats.active).toBe(0);
  });
});

describe('ReportConcurrencyGuard', () => {
  it('releases the permit when the response closes (finish or client abort)', async () => {
    const lim = new ReportConcurrencyLimiter(opts);
    const guard = new ReportConcurrencyGuard(lim);
    const a = fakeCtx();
    const b = fakeCtx();
    await guard.canActivate(a.ctx);
    await guard.canActivate(b.ctx);
    expect(lim.stats.active).toBe(2);
    a.res.emit('close');
    b.res.emit('close');
    expect(lim.stats.active).toBe(0);
    expect(a.res.listenerCount('close')).toBe(0);
  });

  it('error path: response close after a failed handler still returns the permit', async () => {
    const lim = new ReportConcurrencyLimiter({ ...opts, maxConcurrency: 1 });
    const guard = new ReportConcurrencyGuard(lim);
    const a = fakeCtx();
    await guard.canActivate(a.ctx);
    a.res.writableEnded = true; // filter wrote the error body
    a.res.emit('close');
    expect(lim.stats.active).toBe(0);
  });

  it('client abort while queued leaves the queue without taking a permit', async () => {
    const lim = new ReportConcurrencyLimiter({ ...opts, maxConcurrency: 1 });
    const guard = new ReportConcurrencyGuard(lim);
    const a = fakeCtx();
    const b = fakeCtx();
    await guard.canActivate(a.ctx);
    const pending = guard.canActivate(b.ctx).catch((e) => e);
    await tick();
    expect(lim.stats.queued).toBe(1);
    b.res.emit('close');
    expect(await pending).toBeInstanceOf(ReportBusyException);
    expect(lim.stats).toEqual({ active: 1, queued: 0 });
    a.res.emit('close');
    expect(lim.stats.active).toBe(0);
  });

  it('queue full -> 503 with Retry-After: 2', async () => {
    const lim = new ReportConcurrencyLimiter({ maxConcurrency: 1, queueMax: 0, queueTimeoutMs: 100 });
    const guard = new ReportConcurrencyGuard(lim);
    await guard.canActivate(fakeCtx().ctx);
    const c = fakeCtx();
    const err = await guard.canActivate(c.ctx).catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse().code).toBe('SERVICE_BUSY');
    expect(c.res.headers['Retry-After']).toBe('2');
  });
});

describe('DashboardReportGuard', () => {
  it('cache hit takes no permit; miss does', async () => {
    const lim = new ReportConcurrencyLimiter({ ...opts, maxConcurrency: 1 });
    let live = true;
    const guard = new DashboardReportGuard(lim, { hasLiveEntry: () => live } as never);
    await guard.canActivate(fakeCtx().ctx);
    expect(lim.stats.active).toBe(0);
    live = false;
    await guard.canActivate(fakeCtx().ctx);
    expect(lim.stats.active).toBe(1);
  });
});

describe('guard wiring', () => {
  const guardsOf = (fn: object) => (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];
  it('every report read and export route (incl. exports) is under the semaphore', () => {
    for (const [ctrl, skip] of [[ReportsController, 'constructor'], [AgingReportController, 'constructor']] as const) {
      const names = Object.getOwnPropertyNames(ctrl.prototype).filter((n) => n !== skip);
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(guardsOf((ctrl.prototype as never)[n]).length, n).toBe(1);
    }
    expect(guardsOf(ReportsController.prototype.exportSales)[0]).toBe(ReportConcurrencyGuard);
    expect(guardsOf(ReportsController.prototype.getDashboard)[0]).toBe(DashboardReportGuard);
  });
});
