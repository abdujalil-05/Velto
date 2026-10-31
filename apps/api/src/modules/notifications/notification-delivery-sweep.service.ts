import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { systemPrisma } from '@velto/database';
import { addTracedJobReplacingTerminal } from '../../common/queue/trace-job';
import {
  NOTIFICATION_DELIVERY_JOB_OPTS,
  NOTIFICATION_DELIVERY_QUEUE,
  NOTIFICATION_SWEEP_BATCH,
  NOTIFICATION_SWEEP_INTERVAL_MS,
  NOTIFICATION_SWEEP_MAX_CONSECUTIVE_FAILURES,
  TELEGRAM_LEASE_MS,
  notificationJobId,
  type NotificationDeliveryJobData,
} from './notification-delivery.constants';

/**
 * ADR-060a cross-tenant sweep (systemPrisma, read-only): re-enqueues due PENDING rows and lease-expired SENDING
 * rows (lost enqueue, Redis outage, crashed worker, backoff elapsed). It never changes row state — the worker's
 * CAS claim does — so a Redis error leaves the DB untouched and the next tick retries. Legacy rows
 * (telegramStatus NULL) are never matched.
 */
@Injectable()
export class NotificationDeliverySweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliverySweepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@InjectQueue(NOTIFICATION_DELIVERY_QUEUE) private readonly queue: Queue<NotificationDeliveryJobData>) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep().catch((e) => this.logger.error(`sweep failed: ${e instanceof Error ? e.name : 'error'}`)), NOTIFICATION_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns the number of rows (re-)enqueued. */
  async sweep(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const leaseCutoff = new Date(now.getTime() - TELEGRAM_LEASE_MS);
      const due = await systemPrisma.notification.findMany({
        where: {
          OR: [
            { telegramStatus: 'PENDING', OR: [{ telegramNextAttemptAt: null }, { telegramNextAttemptAt: { lte: now } }] },
            { telegramStatus: 'SENDING', telegramClaimedAt: { lt: leaseCutoff } },
          ],
        },
        select: { id: true, companyId: true },
        orderBy: { updatedAt: 'asc' },
        take: NOTIFICATION_SWEEP_BATCH,
      });
      let enqueued = 0;
      let consecutiveFailures = 0;
      for (const n of due) {
        try {
          await addTracedJobReplacingTerminal(this.queue, 'deliver', { notificationId: n.id, companyId: n.companyId }, { ...NOTIFICATION_DELIVERY_JOB_OPTS, jobId: notificationJobId(n.id) });
          enqueued++;
          consecutiveFailures = 0;
        } catch (e) {
          this.logger.warn(`re-enqueue failed for notification ${n.id} (company ${n.companyId}): ${e instanceof Error ? e.name : 'error'}`);
          if (++consecutiveFailures >= NOTIFICATION_SWEEP_MAX_CONSECUTIVE_FAILURES) break; // Redis is down: rows stay due for the next tick
        }
      }
      return enqueued;
    } finally {
      this.running = false;
    }
  }
}
