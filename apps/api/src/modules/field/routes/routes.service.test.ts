import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { OutletNotFoundException } from '../../customers/customers-exceptions';
import { AgentNotFoundException, RouteNotFoundException } from '../field-exceptions';
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
});
