import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { TooManyLoginAttemptsException } from '../../common/auth/auth-exceptions';

const WINDOW_SECONDS = 15 * 60;
const DELAY_AFTER = 5; // SEC-010..019: kechikish 5 urinishdan keyin
const BLOCK_AFTER = 10; // ... blok 10dan keyin
const DELAY_MS_PER_ATTEMPT = 1000;

/** Keyed by phone, not IP — the attacker's leverage is a phone number + password guesses, not a fixed IP. */
@Injectable()
export class LoginRateLimiterService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(phone: string) {
    return `login:fail:${phone}`;
  }

  async assertNotBlocked(phone: string): Promise<void> {
    const count = Number((await this.redis.get(this.key(phone))) ?? 0);
    if (count >= BLOCK_AFTER) {
      const ttl = await this.redis.ttl(this.key(phone));
      throw new TooManyLoginAttemptsException(Math.max(ttl, 1));
    }
    if (count >= DELAY_AFTER) {
      await new Promise((resolve) => setTimeout(resolve, (count - DELAY_AFTER + 1) * DELAY_MS_PER_ATTEMPT));
    }
  }

  async recordFailure(phone: string): Promise<void> {
    const key = this.key(phone);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, WINDOW_SECONDS);
    }
  }

  async recordSuccess(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }
}
