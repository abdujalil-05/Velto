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

  /**
   * Telegram initData replay policy (TZ 7.4/11.1/16.3). Strictly single-use would break
   * legitimate Mini App flows that re-submit the same initData (phone-link polling, retry
   * after /auth/me failure, logout+reload), so instead: initData is fresh for 10 min
   * (TELEGRAM_INITDATA_MAX_AGE_SECONDS; a stolen string dies quickly) and one signed
   * initData (keyed by its hash) may log in at most 20 times (TELEGRAM_INITDATA_MAX_USES;
   * covers ~9 polls + retries + reloads with headroom, still bounds replay).
   * INCR+EXPIRE run in one Lua script so the TTL is set atomically on the first use.
   * Returns the use count so far (caller compares it to the cap). Redis errors propagate (caller fails closed).
   */
  async recordTelegramInitDataUse(hash: string, windowSeconds: number): Promise<number> {
    const count = await this.redis.eval(
      "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c",
      1,
      `tg:initdata:${hash}`,
      windowSeconds,
    );
    return Number(count);
  }

  async recordSuccess(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }
}
