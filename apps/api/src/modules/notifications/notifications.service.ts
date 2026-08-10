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

/** Contact details of the buyer placing a new PurchaseOrder — sent to the supplier so they know who to prepare stock for. */
export interface SupplierOrderNotice {
  companyName: string;
  contactFirstName: string;
  contactLastName: string;
  address: string | null;
  phone: string | null;
  orderNumber: string;
}

/** SalesOrder → deliverer-Supplier assignment notice (F-M0x supplier delivery flow). */
export interface SupplierOrderAssignedNotice {
  companyName: string;
  orderNumber: string;
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

  /**
   * Suppliers are not `User` rows (see `SupplierTelegramLink`'s doc comment)
   * so they can never be a `notify()` recipient — this is the Telegram-only
   * counterpart of that method for the one thing a Supplier needs pushed to
   * it: a newly placed PurchaseOrder. Best-effort/silent, same as `notify()`'s
   * Telegram leg: returns false (no throw) when the bot isn't configured or
   * the supplier hasn't linked Telegram, so the caller can still record an
   * accurate audit-log entry either way.
   */
  async notifySupplierNewOrder(tx: TenantClient, supplierId: string, notice: SupplierOrderNotice): Promise<boolean> {
    const link = await tx.supplierTelegramLink.findFirst({ where: { supplierId, isActive: true } });
    if (!link) return false;

    const lines = [
      `Yangi buyurtma: ${notice.orderNumber}`,
      `Kompaniya: ${notice.companyName}`,
      `Kontakt: ${notice.contactFirstName} ${notice.contactLastName}`,
      notice.address ? `Manzil: ${notice.address}` : undefined,
      notice.phone ? `Telefon: ${notice.phone}` : undefined,
    ].filter((line): line is string => Boolean(line));

    await this.sendTelegram(link.telegramId, lines.join('\n'));
    return true;
  }

  /**
   * Best-effort Telegram push telling a Supplier they've been assigned as
   * the deliverer of a SalesOrder (either at order-creation time or later,
   * via SalesService.assignSupplier()). Deliberately takes an
   * already-resolved `telegramId` instead of `(tx, supplierId)` like
   * notifySupplierNewOrder above — the caller looks up the active
   * SupplierTelegramLink itself inside its own transaction and defers this
   * call via `TenantContext.afterCommit()`, by which point that transaction
   * (and its `tx`) is gone, so this method can't do its own lookup.
   */
  async notifySupplierOrderAssigned(telegramId: bigint, notice: SupplierOrderAssignedNotice): Promise<void> {
    const lines = [`Sizga yetkazib berish uchun buyurtma biriktirildi: ${notice.orderNumber}`, `Kompaniya: ${notice.companyName}`];
    await this.sendTelegram(telegramId, lines.join('\n'));
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
