import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const als = new AsyncLocalStorage<{ traceId: string }>();

/** Incoming ids must be a UUID-like/opaque token: no whitespace/newlines (log injection). */
const SAFE_TRACE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const TRACE_HEADER = 'x-request-id';

/** The single place trace ids are generated. */
export function newTraceId(): string {
  return randomUUID();
}

/** Returns the client's id only if it is safe, else a fresh UUID. */
export function resolveTraceId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_TRACE_ID.test(incoming) ? incoming : newTraceId();
}

export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return als.run({ traceId }, fn);
}

/** Trace id of the request being handled, or undefined outside a request. */
export function getTraceId(): string | undefined {
  return als.getStore()?.traceId;
}
