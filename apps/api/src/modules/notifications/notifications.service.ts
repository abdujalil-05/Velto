import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type TenantClient } from '@velto/database';
import type { LocalizedMessage } from '../../common/errors/app-exception';
import { paginate } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { ListNotificationsQueryDto } from './dto/list-notifications.query';
import { NotificationNotFoundException } from './notifications-exceptions';

export interface NotifyInput {
  recipientId: string;
  type: string;
  title: LocalizedMessage;
  message: LocalizedMessage;
  entityType?: string;
  entityId?: string;
}

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * M14 (5.3: "In-app + Telegram"). The Notification row (in-app) is the
 * reliable channel — it's created first and always succeeds or the whole
 * call fails; Telegram is sent best-effort on top of it afterwards (silently
 * skipped if the bot isn't configured or the recipient hasn't linked
 * Telegram, and any send failure is swallowed) since a Telegram outage must
 * never fail the business operation (e.g. order creation) that triggered
 * the notification.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly configService: ConfigService,
  ) {}

  /** `tx` is explicit (not `this.tenantPrisma.client`) so callers already inside a transaction — e.g. SalesService.create() — write the notification atomically with whatever triggered it. */
  async notify(tx: TenantClient, input: NotifyInput): Promise<void> {
    await tx.notification.create({
      data: {
        companyId: this.tenantPrisma.companyId,
        recipientId: input.recipientId,
        type: input.type,
        title: input.title as unknown as Prisma.InputJsonValue,
        message: input.message as unknown as Prisma.InputJsonValue,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    });

    const recipient = await tx.user.findUnique({ where: { id: input.recipientId }, select: { telegramId: true } });
    if (recipient?.telegramId) {
      // uz only — there's no per-user locale preference anywhere in the schema (6.2) to pick from.
      await this.sendTelegram(recipient.telegramId, `${input.title.uz}\n${input.message.uz}`);
    }
  }

  async notifyMany(tx: TenantClient, recipientIds: string[], input: Omit<NotifyInput, 'recipientId'>): Promise<void> {
    for (const recipientId of recipientIds) {
      await this.notify(tx, { ...input, recipientId });
    }
  }

  async list(recipientId: string, query: ListNotificationsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.NotificationWhereInput = {
      recipientId,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [data, total] = await Promise.all([
      tx.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.notification.count({ where }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  unreadCount(recipientId: string): Promise<number> {
    return this.tenantPrisma.client.notification.count({ where: { recipientId, readAt: null } });
  }

  /** Scoped to `recipientId` — a user can only mark their own notifications, matching SEC-020..024's object-level check pattern (e.g. "agent faqat o'z mijozini ko'radi"). */
  async markRead(id: string, recipientId: string) {
    const tx = this.tenantPrisma.client;
    const notification = await tx.notification.findFirst({ where: { id, recipientId } });
    if (!notification) throw new NotificationNotFoundException();
    if (notification.readAt) return notification;
    return tx.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllRead(recipientId: string): Promise<void> {
    await this.tenantPrisma.client.notification.updateMany({
      where: { recipientId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  private async sendTelegram(telegramId: bigint, text: string): Promise<void> {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    if (!token) return;
    try {
      await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId.toString(), text }),
      });
    } catch {
      // best-effort — see class doc.
    }
  }
}
