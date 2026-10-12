import type { NextFunction, Request, Response } from 'express';
import { resolveTraceId, runWithTraceId, TRACE_HEADER } from './trace-context';

/** Assigns every request a trace id (TZ 12.3), echoes it as X-Request-Id and scopes it via AsyncLocalStorage. */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = resolveTraceId(req.headers[TRACE_HEADER]);
  res.setHeader('X-Request-Id', traceId);
  runWithTraceId(traceId, next);
}
