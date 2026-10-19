import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { REPORT_RETRY_AFTER_SECONDS, ReportBusyException, ReportConcurrencyLimiter } from './report-concurrency.limiter';

/**
 * Route guard for heavy report computations. Guards run after the global
 * JwtAuthGuard and BEFORE interceptors, so the permit is taken before
 * TenantContextInterceptor opens the tenant transaction: a request waiting
 * in the queue holds no pool connection. The permit is released on the
 * response's `close` (fires on normal finish AND on client disconnect), and
 * a client that disconnects while queued leaves the queue.
 */
@Injectable()
export class ReportConcurrencyGuard implements CanActivate {
  constructor(protected readonly limiter: ReportConcurrencyLimiter) {}

  /** Subclasses may bypass the semaphore (e.g. a cache hit that does no DB work). */
  protected shouldSkip(_req: Request): boolean {
    return false;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (this.shouldSkip(req)) return true;

    const abort = new AbortController();
    const onEarlyClose = () => abort.abort();
    res.once('close', onEarlyClose);

    let release: () => void;
    try {
      release = await this.limiter.acquire(abort.signal);
    } catch (e) {
      res.off('close', onEarlyClose);
      if (e instanceof ReportBusyException) res.setHeader('Retry-After', String(REPORT_RETRY_AFTER_SECONDS));
      throw e;
    }
    res.off('close', onEarlyClose);
    if (res.destroyed || res.writableEnded || abort.signal.aborted) {
      release();
      throw new ReportBusyException();
    }
    res.once('close', release);
    return true;
  }
}
