import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { companyTimeZone } from '../analytics/report-utils';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService, computeSubscription } from './settings.service';

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

  it('rejects a non-IANA timezone with INVALID_TIMEZONE and accepts a valid one', async () => {
    await expect(tenantPrisma.run(companyId, () => settings.update(companyId, { timezone: 'Mars/Olympus' }, user))).rejects.toMatchObject({
      response: { code: 'INVALID_TIMEZONE' },
    });
    const ok = await tenantPrisma.run(companyId, () => settings.update(companyId, { timezone: 'Asia/Samarkand' }, user));
    expect(ok.timezone).toBe('Asia/Samarkand');
  });

  it('companyTimeZone falls back to Asia/Tashkent for a legacy invalid stored value', async () => {
    await systemPrisma.company.update({ where: { id: companyId }, data: { timezone: 'Legacy/Nowhere' } });
    const tz = await tenantPrisma.run(companyId, (tx) => companyTimeZone(tx));
    expect(tz).toBe('Asia/Tashkent');
  });
});

describe('computeSubscription (ADR-040)', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  it('null trialEndsAt => ACTIVE', () => {
    expect(computeSubscription('START', null, 'Asia/Tashkent', now)).toMatchObject({ status: 'ACTIVE', daysLeft: null });
  });
  it('future => TRIAL with calendar daysLeft', () => {
    const r = computeSubscription('START', new Date('2026-10-26T12:00:00Z'), 'Asia/Tashkent', now);
    expect(r).toMatchObject({ status: 'TRIAL', daysLeft: 7 });
  });
  it('past or equal => TRIAL_EXPIRED, daysLeft 0', () => {
    expect(computeSubscription('START', new Date('2026-10-18T00:00:00Z'), 'Asia/Tashkent', now)).toMatchObject({ status: 'TRIAL_EXPIRED', daysLeft: 0 });
    expect(computeSubscription('START', now, 'Asia/Tashkent', now).status).toBe('TRIAL_EXPIRED');
  });
  it('day count uses company timezone at the date boundary', () => {
    // 2026-10-19T20:00Z is already 10-20 01:00 in Tashkent (+5) but still 10-19 in UTC.
    const n = new Date('2026-10-19T20:00:00Z');
    const end = new Date('2026-10-21T10:00:00Z');
    expect(computeSubscription('START', end, 'Asia/Tashkent', n).daysLeft).toBe(1);
    expect(computeSubscription('START', end, 'UTC', n).daysLeft).toBe(2);
  });
});

describe('SettingsService subscription (integration, RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const settings = new SettingsService(tenantPrisma, new AuditLogService());
  const ids: { companyId: string; user: AuthenticatedUser }[] = [];

  beforeAll(async () => {
    for (const [i, trialEndsAt] of [[1, new Date(Date.now() + 5 * 86_400_000)], [2, null]] as const) {
      const tenant = await systemPrisma.tenant.create({ data: { slug: `test-sub-${i}-${Date.now()}`, name: `Sub ${i}`, trialEndsAt } });
      const companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Sub Co ${i}` } })).id;
      const u = await systemPrisma.user.create({ data: { companyId, firstName: 'O', lastName: 'W', phone: `+99890000009${i}` } });
      ids.push({ companyId, user: { id: u.id, companyId, firstName: 'O', lastName: 'W', roles: ['OWNER'], permissions: ['settings.update'] } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('GET returns each tenant its own subscription (no cross-tenant bleed)', async () => {
    const a = await tenantPrisma.run(ids[0]!.companyId, () => settings.get(ids[0]!.companyId));
    const b = await tenantPrisma.run(ids[1]!.companyId, () => settings.get(ids[1]!.companyId));
    expect(a.subscription).toMatchObject({ status: 'TRIAL', plan: 'START' });
    expect(a.subscription.daysLeft).toBeGreaterThanOrEqual(4);
    expect(b.subscription).toMatchObject({ status: 'ACTIVE', trialEndsAt: null, daysLeft: null });
  });

  it('PATCH cannot change plan/trialEndsAt (DTO whitelist rejects them)', async () => {
    const dto = plainToInstance(UpdateSettingsDto, { plan: 'ENTERPRISE', trialEndsAt: '2030-01-01' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property).sort()).toEqual(['plan', 'trialEndsAt']);
  });
});
