import { Injectable, Logger } from '@nestjs/common';
import { GpsStatus, Prisma, type TenantClient } from '@velto/database';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { companyDay } from './company-day';

export const FIELD_GPS_UNVERIFIED_NOTIFICATION = 'field.gps_unverified';
export const FIELD_OUTLET_NO_COORDS_NOTIFICATION = 'field.outlet_no_coords';

const UNVERIFIED: GpsStatus[] = [GpsStatus.LOW_ACCURACY, GpsStatus.OUTSIDE_RADIUS, GpsStatus.NO_PERMISSION, GpsStatus.NO_FIX];
const RECIPIENT_ROLES = ['OWNER', 'SALES_DIRECTOR'];

export function isGpsUnverified(status: GpsStatus): boolean {
  return UNVERIFIED.includes(status);
}

/**
 * F3 data-quality alerts, in-app only. Batched: at most one notification per
 * company per company-timezone day per type (to OWNER + SALES_DIRECTOR); the text
 * carries the day's count at the moment it was sent. Never throws.
 */
@Injectable()
export class FieldAlertService {
  private readonly logger = new Logger(FieldAlertService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Register post-commit hook for an unverified-GPS visit. Safe to call inside a request tx. */
  scheduleGpsUnverified(status: GpsStatus): void {
    if (!isGpsUnverified(status)) return;
    const companyId = this.tenantPrisma.companyId;
    TenantContext.afterCommit(() => this.alertGpsUnverified(companyId));
  }

  scheduleOutletNoCoords(count: number): void {
    if (count <= 0) return;
    const companyId = this.tenantPrisma.companyId;
    TenantContext.afterCommit(() => this.alertOutletNoCoords(companyId, count));
  }

  async alertGpsUnverified(companyId: string, now = new Date()): Promise<number> {
    return this.safely(companyId, FIELD_GPS_UNVERIFIED_NOTIFICATION, now, async (tx, dayStart) => {
      const count = await tx.visit.count({ where: { gpsStatus: { in: UNVERIFIED }, createdAt: { gte: dayStart } } });
      return {
        count: Math.max(count, 1),
        title: {
          uz: 'GPS tasdiqlanmagan tashriflar',
          ru: 'Визиты без подтверждённого GPS',
          en: 'Visits with unverified GPS',
        },
        message: (n: number) => ({
          uz: `Bugun GPS tasdiqlanmagan tashriflar: ${n} ta.`,
          ru: `Визитов без подтверждённого GPS сегодня: ${n}.`,
          en: `Visits with unverified GPS today: ${n}.`,
        }),
      };
    });
  }

  async alertOutletNoCoords(companyId: string, count: number, now = new Date()): Promise<number> {
    return this.safely(companyId, FIELD_OUTLET_NO_COORDS_NOTIFICATION, now, async () => ({
      count,
      title: {
        uz: 'Koordinatasiz savdo nuqtalari',
        ru: 'Торговые точки без координат',
        en: 'Outlets without coordinates',
      },
      message: (n: number) => ({
        uz: `Marshrutni yopishda koordinatasiz savdo nuqtalari: ${n} ta.`,
        ru: `Точек без координат при закрытии маршрута: ${n}.`,
        en: `Outlets without coordinates at route finish: ${n}.`,
      }),
    }));
  }

  private async safely(
    companyId: string,
    type: string,
    now: Date,
    build: (
      tx: TenantClient,
      dayStart: Date,
    ) => Promise<{
      count: number;
      title: { uz: string; ru: string; en: string };
      message: (n: number) => { uz: string; ru: string; en: string };
    }>,
  ): Promise<number> {
    try {
      return await this.tenantPrisma.run(companyId, async (tx) => {
        const company = await tx.company.findFirst({ select: { timezone: true } });
        const dayStart = companyDay(now, company?.timezone ?? 'Asia/Tashkent').start;
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtext('velto.field.alert'), hashtext(${companyId || ''} || ${type}))::text
        `);
        const already = await tx.notification.findFirst({
          where: { type, createdAt: { gte: dayStart } },
          select: { id: true },
        });
        if (already) return 0;
        const users = await tx.user.findMany({
          where: { isActive: true, roles: { some: { role: { code: { in: RECIPIENT_ROLES } } } } },
          select: { id: true },
        });
        if (users.length === 0) return 0;
        const b = await build(tx, dayStart);
        await this.notifications.notifyMany(
          tx,
          users.map((u) => u.id),
          { type, title: b.title, message: b.message(b.count) },
        );
        return users.length;
      });
    } catch (err) {
      this.logger.error(`field alert ${type} failed for company ${companyId}: ${(err as Error).message}`);
      return 0;
    }
  }
}
