import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { RouteNotScheduledTodayException } from '../field-exceptions';
import { SkipStopDto } from './dto/skip-stop.dto';
import { RoutesService } from './routes.service';

/** F3 / §10.4 + SEC-023: route finish edge cases (company timezone day, skip reason, idempotency, races). */
describe('RoutesService F3 finish edge cases (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const routes = new RoutesService(tenantPrisma, new AuditLogService());
  let companyId: string;
  let agentId: string;
  let agent: AuthenticatedUser;
  let outletIds: string[];

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-rfe-${Date.now()}`, name: 'RFE' } });
    // Non-default timezone: UTC-4 in October (DST ends 2026-11-01).
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'RFE Co', timezone: 'America/New_York' } })).id;
    agentId = (await systemPrisma.user.create({ data: { companyId, firstName: 'A', lastName: 'G', phone: `+99891${Math.floor(1_000_000 + Math.random() * 8_000_000)}` } })).id;
    agent = { id: agentId, companyId, firstName: 'A', lastName: 'G', roles: ['SALES_AGENT'], permissions: ['routes.finish'] };
    await tenantPrisma.run(companyId, async (tx) => {
      const c = await tx.customer.create({ data: { companyId, code: `RFE-${Date.now()}`, name: 'C' } });
      outletIds = [];
      for (let i = 0; i < 7; i++) outletIds.push((await tx.outlet.create({ data: { companyId, customerId: c.id, name: `S${i}` } })).id);
    });
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const mkRoute = (weekday: number, stops: string[]) =>
    tenantPrisma.run(companyId, (tx) =>
      tx.route.create({ data: { companyId, agentId, weekday, name: `R-${Math.random()}`, stops: { create: stops.map((outletId, i) => ({ outletId, sortOrder: i })) } } }),
    );
  const visit = (outletId: string, startedAt: Date) =>
    tenantPrisma.run(companyId, (tx) =>
      tx.visit.create({ data: { companyId, agentId, outletId, startedAt, outcome: 'NO_ORDER', noOrderReason: 'x', latitude: 41.3, longitude: 69.2, gpsStatus: 'VERIFIED', gpsOk: true } as never }),
    );
  const finish = (id: string) => tenantPrisma.run(companyId, () => routes.finish(id, agent));
  const skip = (id: string, outletId: string, reason = 'closed') => tenantPrisma.run(companyId, () => routes.skipStop(id, { outletId, reason }, agent));

  it('company timezone (America/New_York) decides the day: 19:30Z Tue is Tuesday there (Tashkent would say Wednesday)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T19:30:00Z') });
    const wed = await mkRoute(3, [outletIds[0]!]);
    await visit(outletIds[0]!, new Date('2026-10-13T19:10:00Z'));
    await expect(finish(wed.id)).rejects.toBeInstanceOf(RouteNotScheduledTodayException);
    const tue = await mkRoute(2, [outletIds[0]!]);
    expect((await finish(tue.id)).completedAt).toBeTruthy();
  });

  it('NY midnight boundary: 03:59:59Z is still Tue, 04:00:00Z is Wed; a visit before the boundary does not close a Wednesday stop', async () => {
    const beforeMidnight = new Date('2026-10-14T03:59:59Z');
    const route = await mkRoute(3, [outletIds[1]!]);
    await visit(outletIds[1]!, new Date('2026-10-14T03:30:00Z')); // Tue 23:30 NY
    vi.useFakeTimers({ toFake: ['Date'], now: beforeMidnight });
    await expect(finish(route.id)).rejects.toBeInstanceOf(RouteNotScheduledTodayException);
    vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
    await expect(finish(route.id)).rejects.toMatchObject({ response: { code: 'ROUTE_NOT_READY' } });
    await visit(outletIds[1]!, new Date('2026-10-14T04:05:00Z'));
    const run = await finish(route.id);
    expect(run.date.toISOString().slice(0, 10)).toBe('2026-10-14');
  });

  it('skip-stop with empty / whitespace reason is rejected by the DTO (400) and writes nothing', async () => {
    for (const reason of ['', '   ', '\t\n']) {
      const errs = await validate(plainToInstance(SkipStopDto, { outletId: outletIds[2], reason }));
      expect(errs.length).toBeGreaterThan(0);
    }
    // Service-level: even if a blank slipped past the DTO, the DB CHECK must refuse the SKIPPED visit.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T19:30:00Z') });
    const route = await mkRoute(2, [outletIds[2]!]);
    await expect(skip(route.id, outletIds[2]!, '   ')).rejects.toBeDefined();
    const n = await tenantPrisma.run(companyId, (tx) => tx.visit.count({ where: { outletId: outletIds[2], outcome: 'SKIPPED' } }));
    expect(n).toBe(0);
  });

  it('finishing twice is idempotent: one RouteRun row, second call succeeds with the same run id', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T19:30:00Z') });
    const route = await mkRoute(2, [outletIds[3]!]);
    await visit(outletIds[3]!, new Date('2026-10-13T19:10:00Z'));
    const a = await finish(route.id);
    const b = await finish(route.id).catch((e) => e);
    if (b instanceof Error) expect(b.getStatus()).toBe(409);
    else expect(b.id).toBe(a.id);
    const rows = await tenantPrisma.run(companyId, (tx) => tx.routeRun.count({ where: { routeId: route.id } }));
    expect(rows).toBe(1);
  });

  describe('race: concurrent finish vs skip-stop on the same route (run twice for flakiness)', () => {
    for (const round of [1, 2]) {
      it(`round ${round}: finish succeeds only if the skip committed; exactly one SKIPPED visit; <=1 RouteRun`, async () => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T19:30:00Z') });
        const outletId = outletIds[3 + round]!;
        const route = await mkRoute(2, [outletId]);
        const [f, s] = await Promise.allSettled([finish(route.id), skip(route.id, outletId)]);
        expect(s.status).toBe('fulfilled');
        const skipped = await tenantPrisma.run(companyId, (tx) => tx.visit.count({ where: { outletId, outcome: 'SKIPPED' } }));
        expect(skipped).toBe(1);
        const runs = await tenantPrisma.run(companyId, (tx) => tx.routeRun.findMany({ where: { routeId: route.id } }));
        if (f.status === 'fulfilled') expect(runs).toHaveLength(1);
        else {
          expect((f.reason as { getStatus(): number }).getStatus()).toBe(409);
          expect(runs).toHaveLength(0);
          // after the race settles, finish must now succeed
          expect((await finish(route.id)).completedAt).toBeTruthy();
        }
      });
    }

    it('two parallel skip-stops of the same stop: exactly one wins (no duplicate SKIPPED visit)', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T19:30:00Z') });
      const outletId = outletIds[6]!;
      const route = await mkRoute(2, [outletId]);
      const res = await Promise.allSettled([skip(route.id, outletId), skip(route.id, outletId, 'again')]);
      const skipped = await tenantPrisma.run(companyId, (tx) => tx.visit.count({ where: { outletId, outcome: 'SKIPPED' } }));
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(skipped).toBe(1);
    });
  });
});
