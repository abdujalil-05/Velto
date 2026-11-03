import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { OutletNotFoundException } from '../../customers/customers-exceptions';
import { companyDay } from '../company-day';
import {
  AgentNotFoundException,
  CourierRouteFinishForbiddenException,
  RouteNotFoundException,
  RouteNotOwnedException,
  RouteNotReadyException,
  RouteStopAlreadyClosedException,
} from '../field-exceptions';
import { CreateRouteDto } from './dto/create-route.dto';
import { RoutesService } from './routes.service';

describe('RoutesService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let agentId: string;
  let courierId: string;
  let outletIds: string[];

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const routes = new RoutesService(tenantPrisma, auditLog);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-routes-${Date.now()}`, name: 'Routes Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Routes Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Dir', lastName: 'Ector', phone: '+998900000030' },
    });
    user = {
      id: dbUser.id,
      companyId,
      firstName: 'Dir',
      lastName: 'Ector',
      roles: ['SALES_DIRECTOR'],
      permissions: ['routes.create', 'routes.update'],
    };

    const agentDbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Agent', lastName: 'Two', phone: '+998900000031' },
    });
    agentId = agentDbUser.id;

    await tenantPrisma.run(companyId, async (tx) => {
      const customer = await tx.customer.create({
        data: { companyId, code: `ROUTE-CUST-${Date.now()}`, name: 'Routes Test Customer' },
      });
      const outlet1 = await tx.outlet.create({ data: { companyId, customerId: customer.id, name: 'Stop 1' } });
      const outlet2 = await tx.outlet.create({ data: { companyId, customerId: customer.id, name: 'Stop 2' } });
      const outlet3 = await tx.outlet.create({ data: { companyId, customerId: customer.id, name: 'Stop 3' } });
      outletIds = [outlet1.id, outlet2.id, outlet3.id];

      // A courier is an ordinary User holding the COURIER system role; this
      // tenant is built by hand, so the role row has to be created too.
      const courierRole = await tx.role.create({
        data: { companyId, code: 'COURIER', name: 'Kuryer', isSystem: true },
      });
      const courier = await tx.user.create({
        data: {
          companyId,
          firstName: 'Kuryer',
          lastName: 'One',
          phone: '+998900000032',
          roles: { create: { roleId: courierRole.id } },
        },
      });
      courierId = courier.id;
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('creates a route, assigning sortOrder from stop array position', async () => {
    const route = await tenantPrisma.run(companyId, () =>
      routes.create(
        { agentId, weekday: 1, name: 'Route A', stops: [{ outletId: outletIds[1]! }, { outletId: outletIds[0]! }] },
        user,
      ),
    );
    expect(route.stops.map((s) => s.outletId)).toEqual([outletIds[1], outletIds[0]]);
    expect(route.stops.map((s) => s.sortOrder)).toEqual([1, 2]);
  });

  it('rejects an unknown outlet', async () => {
    await expect(
      tenantPrisma.run(companyId, () =>
        routes.create({ agentId, weekday: 2, name: 'Route B', stops: [{ outletId: randomUUID() }] }, user),
      ),
    ).rejects.toBeInstanceOf(OutletNotFoundException);
  });

  it('rejects an unknown agent', async () => {
    await expect(
      tenantPrisma.run(companyId, () =>
        routes.create(
          { agentId: randomUUID(), weekday: 2, name: 'Route C', stops: [{ outletId: outletIds[0]! }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(AgentNotFoundException);
  });

  it('update() replaces the stop list when stops are given, leaves it untouched otherwise', async () => {
    const route = await tenantPrisma.run(companyId, () =>
      routes.create({ agentId, weekday: 3, name: 'Route D', stops: [{ outletId: outletIds[0]! }] }, user),
    );

    const renamedOnly = await tenantPrisma.run(companyId, () =>
      routes.update(route.id, { name: 'Route D renamed' }, user),
    );
    expect(renamedOnly.name).toBe('Route D renamed');
    expect(renamedOnly.stops.map((s) => s.outletId)).toEqual([outletIds[0]]);

    const restopped = await tenantPrisma.run(companyId, () =>
      routes.update(route.id, { stops: [{ outletId: outletIds[2]! }, { outletId: outletIds[1]! }] }, user),
    );
    expect(restopped.stops.map((s) => s.outletId)).toEqual([outletIds[2], outletIds[1]]);
  });

  it('update() on an unknown route throws RouteNotFoundException', async () => {
    await expect(
      tenantPrisma.run(companyId, () => routes.update(randomUUID(), { name: 'x' }, user)),
    ).rejects.toBeInstanceOf(RouteNotFoundException);
  });

  it('creates a route with a courierId instead of an agentId — agent stays null, courier is populated', async () => {
    const route = await tenantPrisma.run(companyId, () =>
      routes.create({ courierId, weekday: 4, name: 'Route E (courier)', stops: [{ outletId: outletIds[0]! }] }, user),
    );
    expect(route.agentId).toBeNull();
    expect(route.courierId).toBe(courierId);
    expect(route.courier?.id).toBe(courierId);
  });

  it('list() filters by courierId the same way it filters by agentId', async () => {
    const route = await tenantPrisma.run(companyId, () =>
      routes.create({ courierId, weekday: 5, name: 'Route F (courier)', stops: [{ outletId: outletIds[0]! }] }, user),
    );
    const byCourier = await tenantPrisma.run(companyId, () => routes.list({ page: 1, pageSize: 100, courierId }));
    expect(byCourier.data.map((r) => r.id)).toContain(route.id);

    const byOtherCourier = await tenantPrisma.run(companyId, () =>
      routes.list({ page: 1, pageSize: 100, courierId: randomUUID() }),
    );
    expect(byOtherCourier.data.map((r) => r.id)).not.toContain(route.id);
  });

  it('update() reassigning agentId -> courierId clears the previous agent (DB XOR guard)', async () => {
    const route = await tenantPrisma.run(companyId, () =>
      routes.create({ agentId, weekday: 6, name: 'Route G', stops: [{ outletId: outletIds[0]! }] }, user),
    );
    const reassigned = await tenantPrisma.run(companyId, () => routes.update(route.id, { courierId }, user));
    expect(reassigned.agentId).toBeNull();
    expect(reassigned.courierId).toBe(courierId);
  });

  it('CreateRouteDto: exactly one of agentId/courierId is enforced at the DTO level', async () => {
    const base = { weekday: 1, name: 'X', stops: [{ outletId: outletIds[0]! }] };

    const neither = plainToInstance(CreateRouteDto, base);
    expect(await validate(neither)).not.toHaveLength(0);

    const both = plainToInstance(CreateRouteDto, { ...base, agentId, courierId });
    expect(await validate(both)).not.toHaveLength(0);

    const onlyAgent = plainToInstance(CreateRouteDto, { ...base, agentId });
    expect(await validate(onlyAgent)).toHaveLength(0);

    const onlyCourier = plainToInstance(CreateRouteDto, { ...base, courierId });
    expect(await validate(onlyCourier)).toHaveLength(0);
  });

  describe('F3 finish / skip-stop', () => {
    // 2026-10-13 19:30Z = Wed 2026-10-14 00:30 in Asia/Tashkent (UTC+5), Tue in UTC.
    const NOW = new Date('2026-10-13T19:30:00Z');
    let agent2Id: string;
    let noCoordsOutletId: string;
    const agentUser = (id: string): AuthenticatedUser => ({
      id, companyId, firstName: 'A', lastName: 'G', roles: ['SALES_AGENT'], permissions: ['routes.finish'],
    });

    beforeAll(async () => {
      agent2Id = (await systemPrisma.user.create({
        data: { companyId, firstName: 'Agent', lastName: 'Three', phone: '+998900000033' },
      })).id;
      await tenantPrisma.run(companyId, async (tx) => {
        const customer = await tx.customer.findFirstOrThrow({});
        noCoordsOutletId = (await tx.outlet.create({ data: { companyId, customerId: customer.id, name: 'NoCoords' } })).id;
      });
    });
    afterEach(() => vi.useRealTimers());

    const visit = (outletId: string, startedAt: Date, extra: Record<string, unknown> = {}) =>
      tenantPrisma.run(companyId, (tx) =>
        tx.visit.create({ data: { companyId, agentId, outletId, startedAt, outcome: 'NO_ORDER', noOrderReason: 'x', ...extra } as never }),
      );
    const verified = { latitude: 41.3, longitude: 69.2, gpsStatus: 'VERIFIED', gpsOk: true };
    const mkRoute = (name: string, stops: string[]) =>
      tenantPrisma.run(companyId, () =>
        routes.create({ agentId, weekday: 3, name, stops: stops.map((outletId) => ({ outletId })) }, user),
      );

    it('companyDay: Tashkent midnight boundary', () => {
      const before = companyDay(new Date('2026-10-13T18:59:59.999Z'), 'Asia/Tashkent');
      const after = companyDay(new Date('2026-10-13T19:00:00Z'), 'Asia/Tashkent');
      expect(before.date).toBe('2026-10-13');
      expect(before.isoWeekday).toBe(2);
      expect(after.date).toBe('2026-10-14');
      expect(after.isoWeekday).toBe(3);
      expect(after.start.toISOString()).toBe('2026-10-13T19:00:00.000Z');
      expect(after.end.toISOString()).toBe('2026-10-14T19:00:00.000Z');
    });

    it('finish uses the company day: 00:30 Tashkent is Wednesday, a 23:00 Tashkent visit does not count', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const route = await mkRoute('F-day', [outletIds[0]!]);
      await visit(outletIds[0]!, new Date('2026-10-13T18:00:00Z'), verified); // Tue 23:00 Tashkent
      const err = await tenantPrisma.run(companyId, () => routes.finish(route.id, agentUser(agentId))).catch((e) => e);
      expect(err).toBeInstanceOf(RouteNotReadyException);
      expect(err.getResponse().details.openStops[0]).toMatchObject({ outletId: outletIds[0], reason: 'NO_VISIT' });

      await visit(outletIds[0]!, new Date('2026-10-13T19:10:00Z'), verified);
      const run = await tenantPrisma.run(companyId, () => routes.finish(route.id, agentUser(agentId)));
      expect(run.completedAt).toBeTruthy();
      expect(run.date.toISOString().slice(0, 10)).toBe('2026-10-14');
      expect(run.outletNoCoordsCount).toBe(0);
    });

    it('unverified GPS visit keeps the stop open; skip with reason closes it; no-coords outlet counts', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const route = await mkRoute('F-skip', [outletIds[1]!, outletIds[2]!, noCoordsOutletId]);
      const t = new Date('2026-10-13T19:10:00Z');
      await visit(outletIds[1]!, t, { latitude: 41.3, longitude: 69.2, gpsStatus: 'OUTSIDE_RADIUS', gpsOk: false });
      await visit(noCoordsOutletId, t, { latitude: 41.3, longitude: 69.2, gpsStatus: 'OUTLET_NO_COORDS' });
      const err = await tenantPrisma.run(companyId, () => routes.finish(route.id, agentUser(agentId))).catch((e) => e);
      expect(err).toBeInstanceOf(RouteNotReadyException);
      expect(err.getResponse().details.openStops).toEqual([
        { outletId: outletIds[1], outletName: 'Stop 2', reason: 'OUTSIDE_RADIUS' },
        { outletId: outletIds[2], outletName: 'Stop 3', reason: 'NO_VISIT' },
      ]);

      for (const outletId of [outletIds[1]!, outletIds[2]!]) {
        await tenantPrisma.run(companyId, () => routes.skipStop(route.id, { outletId, reason: 'closed' }, agentUser(agentId)));
      }
      await expect(
        tenantPrisma.run(companyId, () => routes.skipStop(route.id, { outletId: outletIds[2]!, reason: 'again' }, agentUser(agentId))),
      ).rejects.toBeInstanceOf(RouteStopAlreadyClosedException);

      const run = await tenantPrisma.run(companyId, () => routes.finish(route.id, agentUser(agentId)));
      expect(run.outletNoCoordsCount).toBe(1);
      expect(run.outletNoCoordsStops).toEqual([{ outletId: noCoordsOutletId, outletName: 'NoCoords' }]);
    });

    it('agent cannot finish/skip another agent route; manager (routes.update) can reach it', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const route = await mkRoute('F-own', [outletIds[0]!]);
      await expect(tenantPrisma.run(companyId, () => routes.finish(route.id, agentUser(agent2Id)))).rejects.toBeInstanceOf(RouteNotOwnedException);
      await expect(
        tenantPrisma.run(companyId, () => routes.skipStop(route.id, { outletId: outletIds[0]!, reason: 'x' }, agentUser(agent2Id))),
      ).rejects.toBeInstanceOf(RouteNotOwnedException);
      // director: passes the ownership gate (the agent's earlier visit already closed the stop)
      await expect(tenantPrisma.run(companyId, () => routes.finish(route.id, user))).resolves.toMatchObject({ routeId: route.id });
    });

    it('courier route cannot be finished', async () => {
      const route = await tenantPrisma.run(companyId, () =>
        routes.create({ courierId, weekday: 3, name: 'F-courier', stops: [{ outletId: outletIds[0]! }] }, user),
      );
      await expect(tenantPrisma.run(companyId, () => routes.finish(route.id, user))).rejects.toBeInstanceOf(CourierRouteFinishForbiddenException);
    });
  });
});
