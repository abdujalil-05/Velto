import type { TraceableJobData } from '../../common/queue/trace-job';

export const NOTIFICATION_DELIVERY_QUEUE = 'notification-telegram';

export interface NotificationDeliveryJobData extends TraceableJobData {
  notificationId: string;
  companyId: string;
}

/** BullMQ retries only infrastructure (DB) errors; Telegram retries are domain-driven (row + sweep), see NotificationDeliveryService. */
export const NOTIFICATION_DELIVERY_JOB_OPTS = { attempts: 3, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 };

/** ADR-060a: total send attempts per row (initial + retries) before FAILED. */
export const TELEGRAM_MAX_ATTEMPTS = 6;
export const TELEGRAM_BACKOFF_BASE_MS = 30_000;
export const TELEGRAM_BACKOFF_CAP_MS = 60 * 60_000;
/** A SENDING row older than this is a crashed worker's; far above the 10s send timeout. */
export const TELEGRAM_LEASE_MS = 5 * 60_000;
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
export const NOTIFICATION_SWEEP_INTERVAL_MS = 60_000;
export const NOTIFICATION_SWEEP_BATCH = 200;
/** Consecutive enqueue failures after which a sweep tick stops (Redis is down; rows stay for the next tick). */
export const NOTIFICATION_SWEEP_MAX_CONSECUTIVE_FAILURES = 5;

export function telegramBackoffMs(attempts: number): number {
  return Math.min(TELEGRAM_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), TELEGRAM_BACKOFF_CAP_MS);
}

export function notificationJobId(notificationId: string): string {
  return notificationId;
}
