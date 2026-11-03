import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { companyDay } from './company-day';
import { FieldAlertService } from './field-alert.service';

describe('FieldAlertService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  const ids: Record<string, string> = {};
  const tenantPrisma = new TenantPrismaService();
  const alerts = new FieldAlertService(tenantPrisma, new NotificationsService(tenantPrisma, new ConfigService()));

  const countOf = (type: string) =>
    tenantPrisma.run(companyId, (tx) => tx.notification.findMany({ where: { type }, select: { recipientId: true, message: true } }));

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-fa-${Date.now()}`, name: 'FA' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'FA Co' } })).id;
    let n = 0;
    for (const code of ['OWNER', 'SALES_DIRECTOR', 'SALES_AGENT']) {
      const role = await systemPrisma.role.create({ data: { companyId, name: code, code, isSystem: true } });
      const u = await systemPrisma.user.create({
        data: { companyId, firstName: code, lastName: 'T', phone: `+99890000${Date.now() % 100000}${n++}` },
      });
      await systemPrisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
      ids[code] = u.id;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('notifies OWNER and SALES_DIRECTOR only, once per day per type', async () => {
    expect(await alerts.alertOutletNoCoords(companyId, 3)).toBe(2);
    expect(await alerts.alertOutletNoCoords(companyId, 5)).toBe(0);
    const rows = await countOf('field.outlet_no_coords');
    expect(rows.map((r) => r.recipientId).sort()).toEqual([ids.OWNER, ids.SALES_DIRECTOR].sort());
    expect((rows[0]!.message as { en: string }).en).toContain('3');
  });

  it('gps_unverified is a separate type with its own daily dedupe', async () => {
    expect(await alerts.alertGpsUnverified(companyId)).toBe(2);
    expect(await alerts.alertGpsUnverified(companyId)).toBe(0);
    expect(await countOf('field.gps_unverified')).toHaveLength(2);
  });

  it('a new Tashkent day sends again', async () => {
    const tomorrow = new Date(Date.now() + 26 * 3600 * 1000);
    expect(await alerts.alertOutletNoCoords(companyId, 1, tomorrow)).toBe(2);
  });

  it('dedupe day follows Company.timezone, not Tashkent (Pacific/Kiritimati UTC+14)', async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-fa-tz-${Date.now()}`, name: 'FA TZ' } });
    const co = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'FA TZ Co', timezone: 'Pacific/Kiritimati' } });
    const role = await systemPrisma.role.create({ data: { companyId: co.id, name: 'OWNER', code: 'OWNER', isSystem: true } });
    const u = await systemPrisma.user.create({ data: { companyId: co.id, firstName: 'O', lastName: 'T', phone: `+99891${Date.now() % 10000000}` } });
    await systemPrisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const now = new Date();
    const kiri = companyDay(now, 'Pacific/Kiritimati').start;
    const tash = companyDay(now, 'Asia/Tashkent').start;
    // A prior alert 1 min after the EARLIER of the two day starts: inside exactly one of the two windows.
    const earlier = new Date(Math.min(kiri.getTime(), tash.getTime()) + 60_000);
    await systemPrisma.notification.create({
      data: { companyId: co.id, recipientId: u.id, type: 'field.outlet_no_coords', title: {}, message: {}, createdAt: earlier },
    });
    // kiri later than tash: prior row is outside the company window -> sends; otherwise it is inside -> deduped.
    const expected = kiri.getTime() > tash.getTime() ? 1 : 0;
    expect(await alerts.alertOutletNoCoords(co.id, 1, now)).toBe(expected);
  });

  it('never throws (failure isolation)', async () => {
    const broken = new FieldAlertService(tenantPrisma, {
      notifyMany: async () => {
        throw new Error('boom');
      },
    } as unknown as NotificationsService);
    expect(await broken.alertGpsUnverified('00000000-0000-0000-0000-000000000000')).toBe(0);
    const t2 = await systemPrisma.tenant.create({ data: { slug: `test-fa2-${Date.now()}`, name: 'FA2' } });
    const c2 = await systemPrisma.company.create({ data: { tenantId: t2.id, name: 'FA2' } });
    const r = await systemPrisma.role.create({ data: { companyId: c2.id, name: 'OWNER', code: 'OWNER', isSystem: true } });
    const u = await systemPrisma.user.create({ data: { companyId: c2.id, firstName: 'o', lastName: 'o', phone: `+99891${Date.now() % 10000000}` } });
    await systemPrisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
    await expect(broken.alertOutletNoCoords(c2.id, 2)).resolves.toBe(0);
  });
});
