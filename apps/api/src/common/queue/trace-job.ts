import type { Job, Queue } from 'bullmq';
import { getTraceId, newTraceId, runWithTraceId } from '../trace/trace-context';

/** Job payloads carry the originating request's trace id (12.3). Optional: jobs enqueued before this existed have none. */
export interface TraceableJobData {
  traceId?: string;
}

/** Enqueues a job with the current trace id (or a fresh one when called outside a request). */
export function addTracedJob<T extends TraceableJobData>(queue: Queue<T>, name: string, data: Omit<T, 'traceId'>) {
  // BullMQ's Queue.add generics are too strict for a generic T; payload shape is guaranteed by the caller's T.
  return queue.add(name as never, { ...data, traceId: getTraceId() ?? newTraceId() } as never);
}

/** Runs a job handler inside the trace context of the job's stored trace id. */
export function runJobWithTrace<T extends TraceableJobData, R>(job: Job<T>, fn: () => Promise<R>): Promise<R> {
  return runWithTraceId(job.data.traceId ?? newTraceId(), fn);
}
