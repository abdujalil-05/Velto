import type { TraceableJobData } from '../../common/queue/trace-job';

export const RECONCILIATION_QUEUE = 'reconciliation-daily';
export const RECONCILIATION_SCHEDULER_ID = 'reconciliation-daily-0300';
export const RECONCILIATION_TZ = 'Asia/Tashkent';
export const RECONCILIATION_CRON = '0 3 * * *';
/** Notification.type (in-app only). Web needs i18n for it; title/message are already trilingual in the row. */
export const RECONCILIATION_DRIFT_NOTIFICATION = 'reconciliation.drift';
export type ReconciliationJobData = TraceableJobData;
