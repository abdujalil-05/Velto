import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { AuthChallengeInvalidException, AuthChallengeRateLimitedException } from '../../common/auth/auth-exceptions';
import { failClosedOnRedis } from '../../common/redis/redis-unavailable';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export const CHALLENGE_TTL_SECONDS = 5 * 60;

/** One selectable account behind a challenge. `optionId` is opaque and random; companyId/userId never leave the server. */
export interface ChallengeOption {
  optionId: string;
  userId: string;
  companyId: string;
}

/**
 * Server-side state of a multi-step auth flow. `stage` is the extension
 * point for ADR-058: after a company is selected, a 'mfa' stage challenge
 * (same store, same single-use semantics) can be issued instead of tokens.
 */
export interface ChallengePayload {
  /** 'login_company' = pick a company after a correct password; 'reset_account' = pick an account after OTP proof. */
  kind: 'login_company' | 'reset_account';
  stage: 'select_company';
  phone: string;
  options: ChallengeOption[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Redis-backed opaque challenge store (ADR-057/057a). The client only ever
 * holds a random id; Redis key is SHA-256(id) so a Redis dump can't be
 * replayed. Consumption is GETDEL (single-use, atomic). Redis down => 503
 * (fail-closed, ADR-050).
 */
@Injectable()
export class AuthChallengeStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(id: string): string {
    return `auth:challenge:${sha256(id)}`;
  }

  async issue(payload: ChallengePayload): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    await failClosedOnRedis(() => this.redis.set(this.key(id), JSON.stringify(payload), 'EX', CHALLENGE_TTL_SECONDS));
    return id;
  }

  /** Atomically reads and deletes. Unknown, expired, replayed or wrong-kind => AuthChallengeInvalidException. */
  async consume(id: string, kind: ChallengePayload['kind']): Promise<ChallengePayload> {
    const raw = await failClosedOnRedis(() => this.redis.getdel(this.key(id)));
    if (!raw) throw new AuthChallengeInvalidException();
    let payload: ChallengePayload;
    try {
      payload = JSON.parse(raw) as ChallengePayload;
    } catch {
      throw new AuthChallengeInvalidException();
    }
    if (payload.kind !== kind) throw new AuthChallengeInvalidException();
    return payload;
  }

  /** Fixed-window counter; throws once `max` hits are exceeded inside `windowSeconds`. */
  async hit(scope: string, subject: string, max: number, windowSeconds: number): Promise<void> {
    const key = `auth:challenge:rl:${scope}:${sha256(subject)}`;
    const count = await failClosedOnRedis(async () => {
      const c = await this.redis.incr(key);
      if (c === 1) await this.redis.expire(key, windowSeconds);
      return c;
    });
    if (count > max) {
      const ttl = await failClosedOnRedis(() => this.redis.ttl(key));
      throw new AuthChallengeRateLimitedException(Math.max(ttl, 1));
    }
  }
}
