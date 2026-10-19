import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RECONCILIATION_DRIFT_NOTIFICATION } from './reconciliation.constants';
import type { DetectResult } from './reconciliation.service';

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5, no DST

/** Start (UTC instant) of the current Asia/Tashkent calendar day. */
export function tashkentDayStart(now: Date): Date {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - TASHKENT_OFFSET_MS);
}

/**
 * In-app drift alert: OWNER (stock + balance), ACCOUNTANT (balance only).
 * Dedupe: a recipient already holding a `reconciliation.drift` notification
 * created today (Tashkent) is skipped; an advisory xact lock per company
 * serialises concurrent runs so the check-then-insert cannot double-send.
 */
@Injectable()
export class ReconciliationAlertService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async alertIfDrift(companyId: string, result: DetectResult, now = new Date()): Promise<number> {
    if (result.stockFindings + result.balanceFindings === 0) return 0;
    const dayStart = tashkentDayStart(now);
    return this.tenantPrisma.run(companyId, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext('velto.reconciliation.alert'), hashtext(${companyId}))::text
      `);
      const users = await tx.user.findMany({
        where: { isActive: true, roles: { some: { role: { code: { in: ['OWNER', 'ACCOUNTANT'] } } } } },
        select: { id: true, roles: { select: { role: { select: { code: true } } } } },
      });
      let sent = 0;
      for (const u of users) {
        const codes = u.roles.map((r) => r.role.code);
        const isOwner = codes.includes('OWNER');
        const total = isOwner ? result.stockFindings + result.balanceFindings : result.balanceFindings;
        if (total === 0) continue;
        const already = await tx.notification.findFirst({
          where: { recipientId: u.id, type: RECONCILIATION_DRIFT_NOTIFICATION, createdAt: { gte: dayStart } },
          select: { id: true },
        });
        if (already) continue;
        const detail = isOwner
          ? { s: result.stockFindings, b: result.balanceFindings }
          : { s: 0, b: result.balanceFindings };
        await this.notifications.notify(tx, {
          recipientId: u.id,
          type: RECONCILIATION_DRIFT_NOTIFICATION,
          title: {
            uz: 'Ma\'lumotlar nomuvofiqligi aniqlandi',
            ru: 'Обнаружено расхождение данных',
            en: 'Data drift detected',
          },
          message: {
            uz: `Tekshiruv natijasi: ombor — ${detail.s}, balans — ${detail.b} ta nomuvofiqlik.`,
            ru: `Результат сверки: склад — ${detail.s}, баланс — ${detail.b} расхождений.`,
            en: `Reconciliation found ${detail.s} stock and ${detail.b} balance discrepancies.`,
          },
          entityType: 'ReconciliationRun',
          entityId: result.runId,
        });
        sent++;
      }
      return sent;
    }, undefined, { allowNested: true }); // called from the request tx in runManual; migrate to handler scope later
  }
}
