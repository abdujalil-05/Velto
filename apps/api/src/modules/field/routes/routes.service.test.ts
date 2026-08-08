import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { OutletNotFoundException } from '../../customers/customers-exceptions';
import { AgentNotFoundException, RouteNotFoundException } from '../field-exceptions';
import { RoutesService } from './routes.service';

describe('RoutesService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let agentId: string;
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
});
