import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { AgentNotFoundException, VisitNotFoundException, VisitSkipReasonRequiredException } from '../field-exceptions';
import { distanceMeters, evaluateGps } from '../geo';
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

  const mk = (extra: Record<string, unknown>, outletId = outletWithCoordsId) =>
    tenantPrisma.run(companyId, () =>
      visits.create(
        { outletId, startedAt: new Date().toISOString(), outcome: 'ORDERED', ...extra } as never,
        agentUser,
      ),
    );

  it('VERIFIED within radius; stores distanceM, accuracy and derived gpsOk=true', async () => {
    const v = await mk({ latitude: OUTLET_LAT + 0.0003, longitude: OUTLET_LNG, accuracyM: 20, capturedAt: new Date().toISOString() });
    expect(v.gpsStatus).toBe('VERIFIED');
    expect(v.gpsOk).toBe(true);
    expect(Number(v.distanceM)).toBeGreaterThan(30);
    expect(Number(v.gpsAccuracyM)).toBe(20);
    expect(v.gpsCapturedAt).not.toBeNull();
    expect(v.agentId).toBe(agentUser.id);
  });

  it('OUTSIDE_RADIUS is saved (not blocked) with gpsOk=false', async () => {
    const v = await mk({ latitude: OUTLET_LAT + 0.01, longitude: OUTLET_LNG, accuracyM: 10 });
    expect(v.gpsStatus).toBe('OUTSIDE_RADIUS');
    expect(v.gpsOk).toBe(false);
    expect(Number(v.distanceM)).toBeGreaterThan(1000);
  });

  it('LOW_ACCURACY: accuracy above Company.gpsMaxAccuracyM (equal passes)', async () => {
    const at = { latitude: OUTLET_LAT, longitude: OUTLET_LNG };
    expect((await mk({ ...at, accuracyM: 100.01 })).gpsStatus).toBe('LOW_ACCURACY');
    expect((await mk({ ...at, accuracyM: 100 })).gpsStatus).toBe('VERIFIED');
  });

  it('NO_PERMISSION wins over coordinates and stores null coords', async () => {
    const v = await mk({ permissionDenied: true, latitude: OUTLET_LAT, longitude: OUTLET_LNG });
    expect(v.gpsStatus).toBe('NO_PERMISSION');
    expect(v.latitude).toBeNull();
    expect(v.gpsOk).toBeNull();
  });

  it('NO_FIX when no coordinates (or an incomplete pair)', async () => {
    expect((await mk({})).gpsStatus).toBe('NO_FIX');
    expect((await mk({ latitude: OUTLET_LAT })).gpsStatus).toBe('NO_FIX');
  });

  it('OUTLET_NO_COORDS keeps agent coords, gpsOk null; NO_FIX still wins when agent has no fix', async () => {
    const v = await mk({ latitude: OUTLET_LAT, longitude: OUTLET_LNG }, outletWithoutCoordsId);
    expect(v.gpsStatus).toBe('OUTLET_NO_COORDS');
    expect(v.latitude).not.toBeNull();
    expect(v.gpsOk).toBeNull();
    expect((await mk({}, outletWithoutCoordsId)).gpsStatus).toBe('NO_FIX');
  });

  it('evaluateGps boundary: exactly radius = VERIFIED, 0.01m beyond = OUTSIDE_RADIUS; precedence LOW_ACCURACY over OUTSIDE', () => {
    const lat = OUTLET_LAT + 0.002;
    const d = Math.round(distanceMeters(lat, OUTLET_LNG, OUTLET_LAT, OUTLET_LNG) * 100) / 100;
    const base = { latitude: lat, longitude: OUTLET_LNG, outletLatitude: OUTLET_LAT, outletLongitude: OUTLET_LNG, maxAccuracyM: 100 };
    expect(evaluateGps({ ...base, radiusM: d }).status).toBe('VERIFIED');
    expect(evaluateGps({ ...base, radiusM: d - 0.01 }).status).toBe('OUTSIDE_RADIUS');
    expect(evaluateGps({ ...base, radiusM: d - 0.01, accuracyM: 500 }).status).toBe('LOW_ACCURACY');
  });

  it('SKIPPED requires a non-blank skipReason, stores it; skipReason cleared for other outcomes', async () => {
    await expect(mk({ outcome: 'SKIPPED' })).rejects.toBeInstanceOf(VisitSkipReasonRequiredException);
    await expect(mk({ outcome: 'SKIPPED', skipReason: '   ' })).rejects.toBeInstanceOf(VisitSkipReasonRequiredException);
    const v = await mk({ outcome: 'SKIPPED', skipReason: 'Yopiq' });
    expect(v.outcome).toBe('SKIPPED');
    expect(v.skipReason).toBe('Yopiq');
    expect((await mk({ skipReason: 'x' })).skipReason).toBeNull();
  });

  it('list() filters by gpsStatus', async () => {
    const v = await mk({ latitude: OUTLET_LAT + 0.01, longitude: OUTLET_LNG });
    const res = await tenantPrisma.run(companyId, () =>
      visits.list({ page: 1, pageSize: 100, gpsStatus: 'OUTSIDE_RADIUS' }, directorUser),
    );
    expect(res.data.map((x) => x.id)).toContain(v.id);
    expect(res.data.every((x) => x.gpsStatus === 'OUTSIDE_RADIUS')).toBe(true);
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
