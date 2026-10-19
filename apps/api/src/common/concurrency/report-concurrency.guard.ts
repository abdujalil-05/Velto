import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { loadAuthenticatedUser } from '../auth/load-authenticated-user';
import type { AccessTokenPayload } from '../auth/auth.types';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { REPORT_RETRY_AFTER_SECONDS, ReportBusyException, ReportConcurrencyLimiter } from './report-concurrency.limiter';

/**
 * Route guard for heavy report computations. Guards run after the global
 * JwtAuthGuard and BEFORE interceptors, so the permit is taken before
 * TenantContextInterceptor opens the tenant transaction: a request waiting
 * in the queue holds no pool connection. The permit is released on the
 * response's `close` (fires on normal finish AND on client disconnect), and
 * a client that disconnects while queued leaves the queue. A caller lacking the
 * route's @RequirePermission (fresh DB read, short tx released before queueing)
 * takes no permit: it falls through to TenantContextInterceptor, which denies
 * (403 + audit) as before.
 */
@Injectable()
export class ReportConcurrencyGuard implements CanActivate {
  constructor(
    protected readonly limiter: ReportConcurrencyLimiter,
    private readonly reflector: Reflector,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  /** Subclasses may bypass the semaphore (e.g. a cache hit that does no DB work). */
  protected shouldSkip(_req: Request): boolean {
    return false;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (this.shouldSkip(req)) return true;
    if (!(await this.mayHoldPermit(context, req))) return true;

    const abort = new AbortController();
    const onEarlyClose = () => abort.abort();
    res.once('close', onEarlyClose);

    let release: () => void;
    try {
      // Tenant key = companyId from the signed JWT (JwtAuthGuard ran first; no DB).
      const tenantKey = (req as Request & { tokenPayload?: { companyId?: string } }).tokenPayload?.companyId;
      release = await this.limiter.acquire(abort.signal, tenantKey);
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

  /** False when the caller is inactive or lacks the route permission: no permit; the interceptor then rejects (401/403 + audit). */
  private async mayHoldPermit(context: ExecutionContext, req: Request): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const payload = (req as Request & { tokenPayload?: AccessTokenPayload }).tokenPayload;
    if (!payload) return false;
    const actor = await this.tenantPrisma.run(payload.companyId, (tx) => loadAuthenticatedUser(tx, payload.sub, payload.companyId));
    return !!actor && actor.permissions.includes(required);
  }
}
