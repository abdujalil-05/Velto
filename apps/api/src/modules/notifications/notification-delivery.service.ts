import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantClient } from '@velto/database';
import type { LocalizedMessage } from '../../common/errors/app-exception';
import { getTraceId } from '../../common/trace/trace-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  TELEGRAM_LEASE_MS,
  TELEGRAM_MAX_ATTEMPTS,
  TELEGRAM_SEND_TIMEOUT_MS,
  telegramBackoffMs,
} from './notification-delivery.constants';
import { OWNER_ALERT_TYPES } from './owner-alerts';
import { sendTelegramMessage } from './telegram-send';
import { renderTelegramText } from './telegram-text';

export type DeliveryOutcome = 'NOOP' | 'SKIPPED' | 'SENT' | 'RETRY' | 'FAILED';

interface Claim {
  claimedAt: Date;
  attempts: number;
  telegramId: bigint;
  text: string;
}

/**
 * ADR-060/060a: the single Telegram delivery path for tracked Notification rows. Claim (CAS PENDING|stale SENDING
 * -> SENDING, own short tx) -> send (no tx open) -> finalize (CAS on our claim timestamp). Delivery is
 * at-least-once: a crash between a successful send and the SENT write re-sends after the lease expires.
 * Telegram is never called inside a business transaction.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly config: ConfigService,
  ) {}

  async deliver(companyId: string, notificationId: string, now: Date = new Date()): Promise<DeliveryOutcome> {
    const claim = await this.tenantPrisma.run(companyId, (tx) => this.claim(tx, companyId, notificationId, now));
    if (claim === 'NOOP' || claim === 'SKIPPED' || claim === 'FAILED') return claim;

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    // Missing token is a deployment misconfiguration, not "delivered": stay retryable (bounded) so it self-heals once configured, then FAILED visibly.
    const result = token
      ? await sendTelegramMessage(token, claim.telegramId, claim.text, TELEGRAM_SEND_TIMEOUT_MS)
      : ({ ok: false, retryable: true, error: 'TELEGRAM_BOT_TOKEN_MISSING' } as const);

    const finishedAt = new Date();
    const outcome = await this.tenantPrisma.run(companyId, async (tx) => {
      const guard = { id: notificationId, telegramStatus: 'SENDING' as const, telegramClaimedAt: claim.claimedAt };
      if (result.ok) {
        const r = await tx.notification.updateMany({ where: guard, data: { telegramStatus: 'SENT', telegramSentAt: finishedAt, telegramClaimedAt: null, telegramNextAttemptAt: null, telegramLastError: null } });
        return r.count === 1 ? ('SENT' as const) : ('NOOP' as const);
      }
      const terminal = !result.retryable || claim.attempts >= TELEGRAM_MAX_ATTEMPTS;
      const r = await tx.notification.updateMany({
        where: guard,
        data: terminal
          ? { telegramStatus: 'FAILED', telegramClaimedAt: null, telegramNextAttemptAt: null, telegramLastError: result.error }
          : { telegramStatus: 'PENDING', telegramClaimedAt: null, telegramNextAttemptAt: new Date(finishedAt.getTime() + telegramBackoffMs(claim.attempts)), telegramLastError: result.error },
      });
      if (r.count !== 1) return 'NOOP' as const;
      return terminal ? ('FAILED' as const) : ('RETRY' as const);
    });
    if (outcome === 'NOOP') this.logger.warn(`notification ${notificationId}: lease lost before finalize (company ${companyId}) trace=${getTraceId() ?? '-'}`);
    if (outcome === 'FAILED' && !result.ok) {
      this.logger.error(`notification ${notificationId} telegram delivery FAILED company=${companyId} attempts=${claim.attempts} error=${result.error} trace=${getTraceId() ?? '-'}`);
    }
    return outcome;
  }

  private async claim(tx: TenantClient, companyId: string, id: string, now: Date): Promise<Claim | 'NOOP' | 'SKIPPED' | 'FAILED'> {
    const leaseCutoff = new Date(now.getTime() - TELEGRAM_LEASE_MS);
    const won = await tx.notification.updateMany({
      where: {
        id,
        OR: [
          { telegramStatus: 'PENDING', OR: [{ telegramNextAttemptAt: null }, { telegramNextAttemptAt: { lte: now } }] },
          { telegramStatus: 'SENDING', telegramClaimedAt: { lt: leaseCutoff } },
        ],
      },
      data: { telegramStatus: 'SENDING', telegramClaimedAt: now, telegramAttempts: { increment: 1 } },
    });
    if (won.count !== 1) return 'NOOP';

    const row = await tx.notification.findUniqueOrThrow({ where: { id }, select: { recipientId: true, type: true, title: true, message: true, telegramAttempts: true } });
    const settle = (status: 'SKIPPED' | 'FAILED', error: string) =>
      tx.notification.update({ where: { id }, data: { telegramStatus: status, telegramClaimedAt: null, telegramNextAttemptAt: null, telegramLastError: error } });

    // A crashed worker already used its attempts: never exceed the limit.
    if (row.telegramAttempts > TELEGRAM_MAX_ATTEMPTS) {
      await settle('FAILED', 'LEASE_EXPIRED_MAX_ATTEMPTS');
      this.logger.error(`notification ${id} telegram delivery FAILED company=${companyId} attempts=${row.telegramAttempts} error=LEASE_EXPIRED_MAX_ATTEMPTS trace=${getTraceId() ?? '-'}`);
      return 'FAILED';
    }
    // Re-check at send time: the recipient may have been deactivated / unlinked since the row was written.
    const recipient = await tx.user.findFirst({ where: { id: row.recipientId, companyId, isActive: true }, select: { telegramId: true } });
    if (!recipient) {
      await settle('SKIPPED', 'RECIPIENT_INACTIVE');
      return 'SKIPPED';
    }
    if (!recipient.telegramId) {
      await settle('SKIPPED', 'TELEGRAM_NOT_LINKED');
      return 'SKIPPED';
    }
    if (OWNER_ALERT_TYPES.has(row.type)) {
      const stillOwner = await tx.userRole.findFirst({ where: { userId: row.recipientId, role: { code: 'OWNER', companyId } }, select: { userId: true } });
      if (!stillOwner) {
        await settle('SKIPPED', 'RECIPIENT_NOT_OWNER');
        return 'SKIPPED';
      }
    }
    const title = row.title as unknown as LocalizedMessage;
    const message = row.message as unknown as LocalizedMessage;
    // uz only — there is no per-user locale preference in the schema (6.2).
    return { claimedAt: now, attempts: row.telegramAttempts, telegramId: recipient.telegramId, text: renderTelegramText(String(title.uz ?? ''), String(message.uz ?? '')) };
  }
}
