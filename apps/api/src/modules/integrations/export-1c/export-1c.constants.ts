import type { TraceableJobData } from '../../../common/queue/trace-job';

export const EXPORT_1C_QUEUE = '1c-export';

export interface Export1cJobData extends TraceableJobData {
  exportJobId: string;
  companyId: string;
}

/** Queue retry policy: bounded attempts, exponential backoff (7.5). */
export const EXPORT_1C_JOB_OPTS = { attempts: 3, backoff: { type: 'exponential' as const, delay: 10_000 }, removeOnComplete: 1000, removeOnFail: 5000 };

/** Bumped whenever the column/field mapping of the produced file changes (audited per ExportJob). */
/** Bumped to 2: Excel sheets gained the 'Ид' (Velto UUID) column and sanitized text cells. */
export const EXPORT_1C_MAPPING_VERSION = 2;

/** ADR-024: shared by CSV and Excel builders — Velto UUID column, stable across re-exports (1C dedup key). */
export const EXPORT_1C_ID_COLUMN = 'Ид';

/** A job stuck in PROCESSING longer than this is failed by the recovery sweep. */
export const EXPORT_1C_STALE_PROCESSING_MS = 15 * 60_000;

export const EXPORT_1C_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Deterministic object key: a retry overwrites the same object (no orphans). */
export function export1cStorageKey(companyId: string, jobId: string, extension: string): string {
  return `exports/1c/${companyId}/${jobId}.${extension}`;
}

/** QUEUED job untouched this long is considered orphaned (enqueue lost) and is re-enqueued by the sweep. */
export const EXPORT_1C_STALE_QUEUED_MS = 15 * 60_000;

/**
 * An orphaned QUEUED job older than this is failed (frees the active-job limit). ADR-047: default 24h so a
 * Redis/worker outage of an hour or more (16.5.1) does not fail jobs; env ABANDONED_QUEUED_MS overrides.
 */
export function export1cAbandonedQueuedMs(): number {
  const n = Number(process.env.ABANDONED_QUEUED_MS);
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60_000;
}
