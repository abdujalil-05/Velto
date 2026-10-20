import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ReportConcurrencyGuard } from './report-concurrency.guard';
import { ReportBusyException, ReportConcurrencyLimiter } from './report-concurrency.limiter';
import { ReportsController } from '../../modules/analytics/reports.controller';
import { AgingReportController } from '../../modules/finance/reports/aging-report.controller';

const opts = { maxConcurrency: 2, queueMax: 3, queueTimeoutMs: 200 };
const noPermReflector = { getAllAndOverride: () => undefined } as never;
const noTenant = {} as never;
const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeCtx(companyId = 'c1') {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  });
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ tokenPayload: { companyId, sub: 'u1' } }), getResponse: () => res }),
    getHandler: () => fakeCtx,
    getClass: () => fakeCtx,
  } as unknown as ExecutionContext;
  return { res, ctx };
}

describe('ReportConcurrencyGuard permission-first', () => {
  const reflector = { getAllAndOverride: () => 'reports.read' } as never;
  const tenantWith = (permissions: string[]) =>
    ({
      run: async (_c: string, fn: (tx: unknown) => unknown) =>
        fn({
          user: { findFirst: async () => ({ id: 'u1', isActive: true, firstName: 'a', lastName: 'b' }) },
          userRole: { findMany: async () => [{ role: { code: 'X', permissions: permissions.map((code) => ({ permission: { module: 'reports', code } })) } }] },
        }),
    }) as never;

  it('caller without the permission takes no permit (interceptor then denies)', async () => {
    const lim = new ReportConcurrencyLimiter({ ...opts, maxConcurrency: 1 });
    await new ReportConcurrencyGuard(lim, reflector, tenantWith(['export'])).canActivate(fakeCtx().ctx);
    expect(lim.stats.active).toBe(0);
  });

  it('caller with the permission takes a permit', async () => {
    const lim = new ReportConcurrencyLimiter({ ...opts, maxConcurrency: 1 });
    await new ReportConcurrencyGuard(lim, reflector, tenantWith(['read'])).canActivate(fakeCtx().ctx);
    expect(lim.stats.active).toBe(1);
  });
});

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
    const guard = new ReportConcurrencyGuard(lim, noPermReflector, noTenant);
    const a = fakeCtx();
    const b = fakeCtx('c2');
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
    const guard = new ReportConcurrencyGuard(lim, noPermReflector, noTenant);
    const a = fakeCtx();
    await guard.canActivate(a.ctx);
    a.res.writableEnded = true; // filter wrote the error body
    a.res.emit('close');
    expect(lim.stats.active).toBe(0);
  });

  it('client abort while queued leaves the queue without taking a permit', async () => {
    const lim = new ReportConcurrencyLimiter({ ...opts, maxConcurrency: 1 });
    const guard = new ReportConcurrencyGuard(lim, noPermReflector, noTenant);
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
    const guard = new ReportConcurrencyGuard(lim, noPermReflector, noTenant);
    await guard.canActivate(fakeCtx().ctx);
    const c = fakeCtx();
    const err = await guard.canActivate(c.ctx).catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse().code).toBe('SERVICE_BUSY');
    expect(c.res.headers['Retry-After']).toBe('2');
  });
});

describe('ReportConcurrencyLimiter per-tenant quota', () => {
  const q = { maxConcurrency: 2, queueMax: 10, queueTimeoutMs: 500, tenantMaxConcurrency: 1, tenantQueueMax: 2 };

  it('tenant A 3 requests -> only 1 runs; tenant B gets a slot immediately', async () => {
    const lim = new ReportConcurrencyLimiter(q);
    const a1 = await lim.acquire(undefined, 'A');
    let a2Granted = false;
    const a2 = lim.acquire(undefined, 'A').then((r) => ((a2Granted = true), r));
    const a3 = lim.acquire(undefined, 'A').catch((e) => e);
    await tick();
    expect(a2Granted).toBe(false);
    expect(lim.stats).toEqual({ active: 1, queued: 2 });
    const b1 = await lim.acquire(undefined, 'B'); // free global permit, B under cap
    expect(lim.stats.active).toBe(2);
    a1();
    const r2 = await a2;
    expect(a2Granted).toBe(true);
    r2();
    const r3 = await a3;
    (r3 as () => void)();
    b1();
    expect(lim.stats).toEqual({ active: 0, queued: 0 });
  });

  it('tenant queue full -> only A gets 503, B still queues', async () => {
    const lim = new ReportConcurrencyLimiter({ ...q, maxConcurrency: 1 });
    const held = await lim.acquire(undefined, 'A');
    const w = [lim.acquire(undefined, 'A'), lim.acquire(undefined, 'A')];
    await expect(lim.acquire(undefined, 'A')).rejects.toBeInstanceOf(ReportBusyException);
    const b = lim.acquire(undefined, 'B');
    expect(lim.stats.queued).toBe(3);
    held();
    (await w[0])();
    (await w[1])();
    (await b)();
    expect(lim.stats).toEqual({ active: 0, queued: 0 });
  });

  it('capped oldest waiter is skipped so another tenant takes the free permit', async () => {
    const lim = new ReportConcurrencyLimiter(q);
    const a1 = await lim.acquire(undefined, 'A');
    const b1 = await lim.acquire(undefined, 'B');
    const a2 = lim.acquire(undefined, 'A');
    const c1 = lim.acquire(undefined, 'C');
    b1(); // free permit: A is capped, C must get it
    (await c1)();
    a1();
    (await a2)();
    expect(lim.stats).toEqual({ active: 0, queued: 0 });
  });

  it('no leaks after timeout/abort; global cap still holds with quota', async () => {
    const lim = new ReportConcurrencyLimiter({ ...q, queueTimeoutMs: 20 });
    const a1 = await lim.acquire(undefined, 'A');
    await expect(lim.acquire(undefined, 'A')).rejects.toBeInstanceOf(ReportBusyException); // timeout
    const ac = new AbortController();
    const p = lim.acquire(ac.signal, 'A').catch((e) => e);
    ac.abort();
    expect(await p).toBeInstanceOf(ReportBusyException);
    const b1 = await lim.acquire(undefined, 'B');
    await expect(lim.acquire(undefined, 'C')).rejects.toBeInstanceOf(ReportBusyException); // global 2 full -> timeout
    a1();
    b1();
    expect(lim.stats).toEqual({ active: 0, queued: 0 });
    const again = await lim.acquire(undefined, 'A'); // tenant counters were not leaked
    again();
  });
});

describe('guard wiring', () => {
  const guardsOf = (fn: object) => (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];
  it('every report read and export route (incl. exports) is under the semaphore', () => {
    for (const [ctrl, skip] of [[ReportsController, 'constructor'], [AgingReportController, 'constructor']] as const) {
      const names = Object.getOwnPropertyNames(ctrl.prototype).filter((n) => n !== skip && n !== 'getDashboard');
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(guardsOf((ctrl.prototype as never)[n]).length, n).toBe(1);
    }
    expect(guardsOf(ReportsController.prototype.exportSales)[0]).toBe(ReportConcurrencyGuard);
    expect(guardsOf(ReportsController.prototype.getDashboard).length).toBe(0); // permit is taken inside the single compute
  });
});
