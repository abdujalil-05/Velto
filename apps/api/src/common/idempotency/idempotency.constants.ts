import type { TraceableJobData } from '../queue/trace-job';

export const IDEMPOTENCY_CLEANUP_QUEUE = 'idempotency-cleanup';
export const IDEMPOTENCY_TTL_MS = 72 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export type IdempotencyCleanupJobData = TraceableJobData;
