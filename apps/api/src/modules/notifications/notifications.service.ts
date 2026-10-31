import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { Prisma, type TenantClient } from '@velto/database';
import type { LocalizedMessage } from '../../common/errors/app-exception';
import { paginate } from '../../common/pagination/pagination.dto';
import { addTracedJobReplacingTerminal, enqueueBestEffort } from '../../common/queue/trace-job';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { ListNotificationsQueryDto } from './dto/list-notifications.query';
import {
  NOTIFICATION_DELIVERY_JOB_OPTS,
  NOTIFICATION_DELIVERY_QUEUE,
  TELEGRAM_SEND_TIMEOUT_MS,
  notificationJobId,
  type NotificationDeliveryJobData,
} from './notification-delivery.constants';
import { NotificationNotFoundException } from './notifications-exceptions';
import { sendTelegramMessage } from './telegram-send';

export interface NotifyInput {
  recipientId: string;
  type: string;
  title: LocalizedMessage;
  message: LocalizedMessage;
  entityType?: string;
  entityId?: string;
  /** Stable per-recipient idempotency key (e.g. "payment.reverse:<id>"): a repeat insert is a silent no-op. */
  dedupKey?: string;
}

/** SalesOrder → Courier assignment notice (the kuryer delivery flow). */
export interface CourierOrderAssignedNotice {
  companyName: string;
  orderNumber: string;
}

/**
 * M14 (5.3: "In-app + Telegram"), ADR-060. notify() only writes the in-app Notification row inside the caller's
 * transaction, with its Telegram state (PENDING when the recipient is linked, else SKIPPED); no Telegram call
 * happens in any transaction. After COMMIT the row id is enqueued (jobId = id); NotificationDeliveryService
 * delivers it with retry/backoff, and NotificationDeliverySweepService re-enqueues rows whose enqueue was lost.
 * Without an injected queue (unit tests) the sweep is the only trigger.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly configService: ConfigService,
    @Optional() @InjectQueue(NOTIFICATION_DELIVERY_QUEUE) private readonly queue?: Queue<NotificationDeliveryJobData>,
  ) {}

  /** `tx` is explicit (not `this.tenantPrisma.client`) so callers already inside a transaction — e.g. SalesService.create() — write the notification atomically with whatever triggered it. */
  async notify(tx: TenantClient, input: NotifyInput): Promise<void> {
    const companyId = this.tenantPrisma.companyId;
    const recipient = await tx.user.findUnique({ where: { id: input.recipientId }, select: { telegramId: true, isActive: true } });
    const deliverable = Boolean(recipient?.isActive && recipient.telegramId);
    const id = randomUUID();
    // createMany + skipDuplicates = INSERT .. ON CONFLICT DO NOTHING: a dedupKey repeat neither throws nor aborts the caller's tx.
    const { count } = await tx.notification.createMany({
      skipDuplicates: true,
      data: [
        {
          id,
          companyId,
          recipientId: input.recipientId,
          type: input.type,
          title: input.title as unknown as Prisma.InputJsonValue,
          message: input.message as unknown as Prisma.InputJsonValue,
          entityType: input.entityType,
          entityId: input.entityId,
          dedupKey: input.dedupKey,
          telegramStatus: deliverable ? 'PENDING' : 'SKIPPED',
          telegramLastError: deliverable ? null : recipient?.isActive === false ? 'RECIPIENT_INACTIVE' : 'TELEGRAM_NOT_LINKED',
        },
      ],
    });
    if (count === 1 && deliverable) this.enqueueAfterCommit(companyId, id);
  }

  async notifyMany(tx: TenantClient, recipientIds: string[], input: Omit<NotifyInput, 'recipientId'>): Promise<void> {
    for (const recipientId of recipientIds) {
      await this.notify(tx, { ...input, recipientId });
    }
  }

  /** ADR-047: enqueue only after the row is durably visible; failure leaves the PENDING row for the sweep. */
  private enqueueAfterCommit(companyId: string, notificationId: string): void {
    const queue = this.queue;
    if (!queue || !TenantContext.peek()?.txActive) return;
    TenantContext.afterCommit(() =>
      enqueueBestEffort(this.logger, `notification ${notificationId}`, () =>
        addTracedJobReplacingTerminal(queue, 'deliver', { notificationId, companyId }, { ...NOTIFICATION_DELIVERY_JOB_OPTS, jobId: notificationJobId(notificationId) }),
      ),
    );
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
   * Best-effort Telegram push telling a Courier they've been assigned a
   * SalesOrder to deliver (either at order-creation time or later, via
   * SalesService.assignCourier()). Deliberately takes an already-resolved
   * `telegramId` instead of `(tx, courierId)` like `notify()` above — the
   * caller reads `User.telegramId` inside its own transaction and defers this
   * call via `TenantContext.afterCommit()`, by which point that transaction
   * (and its `tx`) is gone, so this method can't do its own lookup.
   */
  async notifyCourierOrderAssigned(telegramId: bigint, notice: CourierOrderAssignedNotice): Promise<void> {
    const lines = [`Sizga yetkazib berish uchun buyurtma biriktirildi: ${notice.orderNumber}`, `Kompaniya: ${notice.companyName}`];
    await this.sendTelegram(telegramId, lines.join('\n'));
  }

  /** Courier assignment pings are not Notification rows: direct best-effort send after commit (a lost one is acceptable, ADR-047). */
  private async sendTelegram(telegramId: bigint, text: string): Promise<void> {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    if (!token) return;
    await sendTelegramMessage(token, telegramId, text, TELEGRAM_SEND_TIMEOUT_MS);
  }
}
