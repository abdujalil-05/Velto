import { createHash } from 'node:crypto';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, type Observable } from 'rxjs';
import { Prisma } from '@velto/database';
import type { AuthenticatedUser } from '../auth/auth.types';
import { TenantContext } from '../tenant/tenant-context';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_TTL_MS } from './idempotency.constants';
import { IdempotencyKeyReusedException, InvalidIdempotencyKeyException } from './idempotency-exceptions';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Runs INSIDE the global TenantContextInterceptor's transaction (method-level
 * interceptors execute after global ones), so the stored record and the
 * business writes commit or roll back together. A pg advisory xact lock on
 * (company,key) serializes concurrent retries: the loser waits for the winner's
 * COMMIT and then replays its stored response. The header is optional.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const raw = req.headers?.[IDEMPOTENCY_KEY_HEADER];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (key === undefined || key === '') return next.handle();
    if (typeof key !== 'string' || key.length > 128) throw new InvalidIdempotencyKeyException();
    return from(this.run(context, next, key));
  }

  private async run(context: ExecutionContext, next: CallHandler, key: string): Promise<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const user = req.user as AuthenticatedUser;
    const tx = TenantContext.client;
    const companyId = TenantContext.companyId;

    const route = `${req.method} ${String(req.originalUrl ?? req.url).split('?')[0]}`;
    const requestHash = createHash('sha256')
      .update(`${route}\n${user.id}\n${stableStringify(req.body ?? null)}`)
      .digest('hex');

    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${companyId}:${key}`}, 0))`);

    const existing = await tx.idempotencyRecord.findUnique({ where: { companyId_key: { companyId, key } } });
    if (existing) {
      if (existing.expiresAt > new Date()) {
        if (existing.requestHash !== requestHash) throw new IdempotencyKeyReusedException();
        res.status(existing.responseStatus);
        return existing.responseBody;
      }
      await tx.idempotencyRecord.delete({ where: { id: existing.id } });
    }

    const result = await new Promise<unknown>((resolve, reject) => {
      next.handle().subscribe({ next: resolve, error: reject, complete: () => resolve(undefined) });
    });

    const httpCode = Reflect.getMetadata('__httpCode__', context.getHandler()) as number | undefined;
    const status = httpCode ?? (req.method === 'POST' ? 201 : 200);
    await tx.idempotencyRecord.create({
      data: {
        companyId,
        key,
        userId: user.id,
        route,
        requestHash,
        responseStatus: status,
        responseBody: (result === undefined ? null : JSON.parse(JSON.stringify(result))) as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
    return result;
  }
}
