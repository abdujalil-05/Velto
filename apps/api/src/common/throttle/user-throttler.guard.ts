import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Buckets by authenticated userId (set by JwtAuthGuard, so this guard must be registered AFTER it);
 * public/unauthenticated routes fall back to the client IP.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const payload = req.tokenPayload as { sub?: string } | undefined;
    return payload?.sub ? `user:${payload.sub}` : String(req.ip ?? 'unknown');
  }
}
