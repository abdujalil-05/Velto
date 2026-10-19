import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { AppException } from '../errors/app-exception';

export class RateLimitedException extends AppException {
  constructor() {
    super(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', {
      uz: "So'rovlar soni oshib ketdi. Birozdan keyin qayta urinib ko'ring",
      ru: 'Слишком много запросов. Повторите попытку позже',
      en: 'Too many requests. Please retry shortly',
    });
  }
}

/**
 * Buckets by authenticated userId (set by JwtAuthGuard, so this guard must be registered AFTER it);
 * public/unauthenticated routes fall back to the client IP.
 *
 * STORAGE: the default ThrottlerModule storage is in-process memory, so counters are per Node process.
 * That is correct ONLY while the API runs as a single PM2 instance (instances=1, ADR-049). Before
 * running cluster mode / several API processes, switch to a shared Redis storage, otherwise every
 * limit (SEC-015 sync 30/60 per minute included) silently multiplies by the instance count.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const payload = req.tokenPayload as { sub?: string } | undefined;
    return payload?.sub ? `user:${payload.sub}` : String(req.ip ?? 'unknown');
  }

  protected override async throwThrottlingException(_context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const res = _context.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>();
    res.setHeader('Retry-After', String(Math.max(detail.timeToBlockExpire || detail.timeToExpire, 1)));
    throw new RateLimitedException();
  }
}
