import type { Job, JobsOptions, Queue } from 'bullmq';
import { DEFAULT_QUEUE_ENQUEUE_TIMEOUT_MS } from '../config/env.schema';
import { getTraceId, newTraceId, runWithTraceId } from '../trace/trace-context';

/** Job payloads carry the originating request's trace id (12.3). Optional: jobs enqueued before this existed have none. */
export interface TraceableJobData {
  traceId?: string;
}

/** Enqueues a job with the current trace id (or a fresh one when called outside a request). */
export function addTracedJob<T extends TraceableJobData>(queue: Queue<T>, name: string, data: Omit<T, 'traceId'>, opts?: JobsOptions) {
  // BullMQ's Queue.add generics are too strict for a generic T; payload shape is guaranteed by the caller's T.
  const payload = { ...data, traceId: getTraceId() ?? newTraceId() } as never;
  const pending = Promise.resolve(opts ? queue.add(name as never, payload, opts) : queue.add(name as never, payload));
  return withEnqueueTimeout(pending);
}

/**
 * Dedup-by-jobId leaves a terminal (completed/failed) BullMQ entry blocking a re-add while the domain row is still
 * non-terminal (orphan). Remove that entry first, then add. Callers' processors are CAS/cursor-protected, so a re-run is safe.
 */
export async function addTracedJobReplacingTerminal<T extends TraceableJobData>(queue: Queue<T>, name: string, data: Omit<T, 'traceId'>, opts: JobsOptions & { jobId: string }) {
  const existing = await withEnqueueTimeout(Promise.resolve(queue.getJob(opts.jobId)));
  if (existing) {
    const state = await withEnqueueTimeout(Promise.resolve(existing.getState()));
    if (state === 'completed' || state === 'failed') await withEnqueueTimeout(Promise.resolve(existing.remove()));
  }
  return addTracedJob(queue, name, data, opts);
}

/** NFR-REL-006: per-enqueue timeout (env QUEUE_ENQUEUE_TIMEOUT_MS, default 3000). */
export function enqueueTimeoutMs(): number {
  const n = Number(process.env.QUEUE_ENQUEUE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUE_ENQUEUE_TIMEOUT_MS;
}

/** BullMQ's connection uses maxRetriesPerRequest:null, so queue.add() hangs while Redis is down; bound it. */
export function withEnqueueTimeout<R>(pending: Promise<R>, ms = enqueueTimeoutMs()): Promise<R> {
  pending.catch(() => undefined); // late rejection after timeout must not be unhandled
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`enqueue timeout after ${ms}ms`)), ms);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Best-effort enqueue for a domain job row already committed as QUEUED (ADR-047): a failure/timeout is logged
 * with the trace id and swallowed; the recovery sweep re-enqueues later (jobId makes that idempotent).
 */
export async function enqueueBestEffort(logger: { warn(msg: string): void }, label: string, enqueue: () => Promise<unknown>): Promise<void> {
  try {
    await enqueue();
  } catch (e) {
    logger.warn(`${label}: enqueue deferred to sweep (${e instanceof Error ? e.message : 'error'}) trace=${getTraceId() ?? '-'}`);
  }
}

/** Runs a job handler inside the trace context of the job's stored trace id. */
export function runJobWithTrace<T extends TraceableJobData, R>(job: Job<T>, fn: () => Promise<R>): Promise<R> {
  return runWithTraceId(job.data.traceId ?? newTraceId(), fn);
}
