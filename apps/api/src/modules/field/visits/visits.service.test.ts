import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { AgentNotFoundException, GpsTooFarException, VisitNotFoundException } from '../field-exceptions';
import { VisitsService } from './visits.service';

describe('VisitsService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let agentUser: AuthenticatedUser;
  let directorUser: AuthenticatedUser;
  let outletWithCoordsId: string;
  let outletWithoutCoordsId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const visits = new VisitsService(tenantPrisma, auditLog);

  const OUTLET_LAT = 41.2995;
  const OUTLET_LNG = 69.2401;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-visits-${Date.now()}`, name: 'Visits Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Visits Test Co' } });
    companyId = company.id;

    const agentDbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Agent', lastName: 'One', phone: '+998900000020' },
    });
    agentUser = {
      id: agentDbUser.id,
      companyId,
      firstName: 'Agent',
      lastName: 'One',
      roles: ['SALES_AGENT'],
      permissions: ['field.create'],
    };

    const directorDbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Sales', lastName: 'Director', phone: '+998900000021' },
    });
    directorUser = {
      id: directorDbUser.id,
      companyId,
      firstName: 'Sales',
      lastName: 'Director',
      roles: ['SALES_DIRECTOR'],
      permissions: ['field.create'],
    };

    await tenantPrisma.run(companyId, async (tx) => {
      const customer = await tx.customer.create({
        data: { companyId, code: `VIS-CUST-${Date.now()}`, name: 'Visits Test Customer' },
      });
      const outletWithCoords = await tx.outlet.create({
        data: { companyId, customerId: customer.id, name: 'With coords', latitude: OUTLET_LAT, longitude: OUTLET_LNG },
      });
      outletWithCoordsId = outletWithCoords.id;

      const outletWithoutCoords = await tx.outlet.create({
        data: { companyId, customerId: customer.id, name: 'Without coords' },
      });
      outletWithoutCoordsId = outletWithoutCoords.id;
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('verifies GPS when the agent is within 150m of the outlet', async () => {
    const visit = await tenantPrisma.run(companyId, () =>
      visits.create(
        {
          outletId: outletWithCoordsId,
          startedAt: new Date().toISOString(),
          latitude: OUTLET_LAT + 0.0003, // ~33m north
          longitude: OUTLET_LNG,
          outcome: 'ORDERED',
        },
        agentUser,
      ),
    );
    expect(visit.gpsOk).toBe(true);
    expect(visit.agentId).toBe(agentUser.id);
  });

  it('hard-blocks a visit more than 150m away — no reason-based bypass', async () => {
    await expect(
      tenantPrisma.run(companyId, () =>
        visits.create(
          {
            outletId: outletWithCoordsId,
            startedAt: new Date().toISOString(),
            latitude: OUTLET_LAT + 0.01, // ~1.1km away
            longitude: OUTLET_LNG,
            outcome: 'NO_ORDER',
            noOrderReason: 'Yopiq edi',
          },
          agentUser,
        ),
      ),
    ).rejects.toBeInstanceOf(GpsTooFarException);
  });

  it('allows a visit at an outlet with no registered coordinates — unverifiable is not the agent\'s fault, so it is not blocked', async () => {
    const visit = await tenantPrisma.run(companyId, () =>
      visits.create(
        {
          outletId: outletWithoutCoordsId,
          startedAt: new Date().toISOString(),
          latitude: OUTLET_LAT,
          longitude: OUTLET_LNG,
          outcome: 'ORDERED',
        },
        agentUser,
      ),
    );
    expect(visit.gpsOk).toBeNull();
  });

  it('requires an explicit agentId when the caller is not a SALES_AGENT, and validates it', async () => {
    await expect(
      tenantPrisma.run(companyId, () =>
        visits.create(
          {
            outletId: outletWithCoordsId,
            startedAt: new Date().toISOString(),
            latitude: OUTLET_LAT,
            longitude: OUTLET_LNG,
            outcome: 'ORDERED',
          },
          directorUser,
        ),
      ),
    ).rejects.toBeInstanceOf(AgentNotFoundException);

    const visit = await tenantPrisma.run(companyId, () =>
      visits.create(
        {
          outletId: outletWithCoordsId,
          agentId: agentUser.id,
          startedAt: new Date().toISOString(),
          latitude: OUTLET_LAT,
          longitude: OUTLET_LNG,
          outcome: 'ORDERED',
        },
        directorUser,
      ),
    );
    expect(visit.agentId).toBe(agentUser.id);
  });

  it('resubmitting the same clientId returns the original visit (10.4 offline idempotency)', async () => {
    const clientId = randomUUID();
    const first = await tenantPrisma.run(companyId, () =>
      visits.create(
        {
          outletId: outletWithCoordsId,
          startedAt: new Date().toISOString(),
          latitude: OUTLET_LAT,
          longitude: OUTLET_LNG,
          outcome: 'ORDERED',
          clientId,
        },
        agentUser,
      ),
    );
    const second = await tenantPrisma.run(companyId, () =>
      visits.create(
        {
          outletId: outletWithCoordsId,
          startedAt: new Date().toISOString(),
          latitude: OUTLET_LAT,
          longitude: OUTLET_LNG,
          outcome: 'NO_ORDER',
          clientId,
        },
        agentUser,
      ),
    );
    expect(second.id).toBe(first.id);
    expect(second.outcome).toBe(first.outcome);
  });

  it('list() filters by from/to (startedAt), leaving unbounded callers unaffected', async () => {
    const visit = await tenantPrisma.run(companyId, () =>
      visits.create(
        {
          outletId: outletWithCoordsId,
          startedAt: new Date().toISOString(),
          latitude: OUTLET_LAT,
          longitude: OUTLET_LNG,
          outcome: 'ORDERED',
        },
        agentUser,
      ),
    );

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const todayList = await tenantPrisma.run(companyId, () =>
      visits.list({ page: 1, pageSize: 100, agentId: agentUser.id, from: today, to: today }, directorUser),
    );
    expect(todayList.data.map((v) => v.id)).toContain(visit.id);

    const futureList = await tenantPrisma.run(companyId, () =>
      visits.list({ page: 1, pageSize: 100, agentId: agentUser.id, from: tomorrow, to: tomorrow }, directorUser),
    );
    expect(futureList.data.map((v) => v.id)).not.toContain(visit.id);

    const unbounded = await tenantPrisma.run(companyId, () =>
      visits.list({ page: 1, pageSize: 100, agentId: agentUser.id }, directorUser),
    );
    expect(unbounded.data.map((v) => v.id)).toContain(visit.id);
  });

  it('SEC-023 (15.3): a SALES_AGENT only sees their own visits via list()/getById()', async () => {
    const otherAgentDbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Agent', lastName: 'Two', phone: `+99890${Date.now().toString().slice(-7)}` },
    });
    const otherAgent: AuthenticatedUser = {
      id: otherAgentDbUser.id,
      companyId,
      firstName: 'Agent',
      lastName: 'Two',
      roles: ['SALES_AGENT'],
      permissions: ['field.create', 'field.read'],
    };

    const visitFor = (u: AuthenticatedUser) =>
      tenantPrisma.run(companyId, () =>
        visits.create(
          {
            outletId: outletWithCoordsId,
            startedAt: new Date().toISOString(),
            latitude: OUTLET_LAT,
            longitude: OUTLET_LNG,
            outcome: 'ORDERED',
          },
          u,
        ),
      );

    const own = await visitFor(agentUser);
    const other = await visitFor(otherAgent);

    const ownList = await tenantPrisma.run(companyId, () => visits.list({ page: 1, pageSize: 100 }, agentUser));
    const ids = ownList.data.map((v) => v.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(other.id);

    // Passing another agent's id must not override the server-enforced scope.
    const spoofed = await tenantPrisma.run(companyId, () =>
      visits.list({ page: 1, pageSize: 100, agentId: otherAgent.id }, agentUser),
    );
    expect(spoofed.data.map((v) => v.id)).not.toContain(other.id);

    await expect(tenantPrisma.run(companyId, () => visits.getById(other.id, agentUser))).rejects.toBeInstanceOf(
      VisitNotFoundException,
    );
    expect((await tenantPrisma.run(companyId, () => visits.getById(own.id, agentUser))).id).toBe(own.id);

    // SALES_DIRECTOR keeps the company-wide view their reports depend on.
    const directorList = await tenantPrisma.run(companyId, () => visits.list({ page: 1, pageSize: 100 }, directorUser));
    expect(directorList.data.map((v) => v.id)).toEqual(expect.arrayContaining([own.id, other.id]));
  });
});
