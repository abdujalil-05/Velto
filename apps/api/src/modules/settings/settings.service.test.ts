import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { SettingsService } from './settings.service';

describe('SettingsService GPS thresholds (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  const tenantPrisma = new TenantPrismaService();
  const settings = new SettingsService(tenantPrisma, new AuditLogService());

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-settings-${Date.now()}`, name: 'Settings Test' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Settings Co' } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'Own', lastName: 'Er', phone: '+998900000077' } });
    user = { id: u.id, companyId, firstName: 'Own', lastName: 'Er', roles: ['OWNER'], permissions: ['settings.update'] };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('updates visitGpsRadiusM / gpsMaxAccuracyM and audits old/new values', async () => {
    const updated = await tenantPrisma.run(companyId, () => settings.update(companyId, { visitGpsRadiusM: 300, gpsMaxAccuracyM: 50 }, user));
    expect(updated.visitGpsRadiusM).toBe(300);
    expect(updated.gpsMaxAccuracyM).toBe(50);
    const rows = await systemPrisma.auditLog.findMany({ where: { companyId, action: 'company.gps_settings_update' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oldValue).toEqual({ visitGpsRadiusM: 150, gpsMaxAccuracyM: 100 });
    expect(rows[0]?.newValue).toEqual({ visitGpsRadiusM: 300, gpsMaxAccuracyM: 50 });
  });

  it('does not write the GPS audit event when thresholds are unchanged', async () => {
    await tenantPrisma.run(companyId, () => settings.update(companyId, { name: 'Renamed' }, user));
    const rows = await systemPrisma.auditLog.findMany({ where: { companyId, action: 'company.gps_settings_update' } });
    expect(rows).toHaveLength(1);
  });
});
