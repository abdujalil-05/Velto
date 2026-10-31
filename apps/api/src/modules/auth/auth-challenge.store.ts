import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  AuthChallengeInvalidException,
  AuthChallengeRateLimitedException,
  MfaChallengeInvalidException,
  MfaRateLimitedException,
  MfaServiceUnavailableException,
} from '../../common/auth/auth-exceptions';
import { failClosedOnRedis, ServiceUnavailableAppException } from '../../common/redis/redis-unavailable';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export const CHALLENGE_TTL_SECONDS = 5 * 60;

/** One selectable account behind a challenge. `optionId` is opaque and random; companyId/userId never leave the server. */
export interface ChallengeOption {
  optionId: string;
  userId: string;
  companyId: string;
}

export const MFA_MAX_ATTEMPTS = 5;

/** 'mfa_verify' = prove an enrolled TOTP/recovery code; 'mfa_enroll' = set up (or replace) TOTP. A scope is valid on its own endpoints only. */
export type MfaScope = 'mfa_verify' | 'mfa_enroll';

/** What an MFA challenge is bound to server-side. `replacesMfaId` pins a re-enrollment to the MFA it replaces (null = first enrollment / verify). */
export interface MfaBinding {
  scope: MfaScope;
  userId: string;
  companyId: string;
  replacesMfaId: string | null;
}

/** What a step-up challenge (re-proof before a sensitive admin action) is bound to. Any mismatch => MFA_CHALLENGE_INVALID. */
export interface StepUpBinding {
  actorId: string;
  sid: string;
  companyId: string;
  targetUserId: string;
  op: 'users.mfa_reset';
}

/**
 * Server-side state of a multi-step auth flow. `stage` is the extension
 * point for ADR-057 flows; MFA challenges (ADR-058) use the separate `*Mfa` methods below.
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

function stepUpMatches(raw: string, expected: StepUpBinding): boolean {
  let stored: Partial<StepUpBinding>;
  try {
    stored = JSON.parse(raw) as Partial<StepUpBinding>;
  } catch {
    return false;
  }
  return (
    stored.actorId === expected.actorId &&
    stored.sid === expected.sid &&
    stored.companyId === expected.companyId &&
    stored.targetUserId === expected.targetUserId &&
    stored.op === expected.op
  );
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

  private mfaKey(id: string): string {
    return `auth:mfa:${sha256(id)}`;
  }

  /** MFA flows must never be skipped: any Redis failure becomes MFA_SERVICE_UNAVAILABLE (503) instead of the generic one. */
  private async mfaRedis<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await failClosedOnRedis(fn);
    } catch (err) {
      if (err instanceof ServiceUnavailableAppException) throw new MfaServiceUnavailableException();
      throw err;
    }
  }

  async issueMfa(binding: MfaBinding): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    await this.mfaRedis(() => this.redis.set(this.mfaKey(id), JSON.stringify(binding), 'EX', CHALLENGE_TTL_SECONDS));
    return id;
  }

  /** Non-consuming read. Unknown, expired, exhausted or wrong-scope => MfaChallengeInvalidException. */
  async readMfa(id: string, scope: MfaScope): Promise<MfaBinding> {
    const raw = await this.mfaRedis(() => this.redis.get(this.mfaKey(id)));
    const binding = raw ? (JSON.parse(raw) as MfaBinding) : null;
    if (!binding || binding.scope !== scope) throw new MfaChallengeInvalidException();
    return binding;
  }

  /** Atomic single-use consumption (GETDEL): exactly one concurrent caller gets the binding. */
  async consumeMfa(id: string, scope: MfaScope): Promise<MfaBinding> {
    const raw = await this.mfaRedis(() => this.redis.getdel(this.mfaKey(id)));
    const binding = raw ? (JSON.parse(raw) as MfaBinding) : null;
    if (!binding || binding.scope !== scope) throw new MfaChallengeInvalidException();
    await this.mfaRedis(() => this.redis.del(`${this.mfaKey(id)}:attempts`, `${this.mfaKey(id)}:pending`));
    return binding;
  }

  /**
   * Atomically reserves one code attempt BEFORE the code is checked (INCR+EXPIRE in one Lua script).
   * Beyond MFA_MAX_ATTEMPTS the challenge is deleted (login must restart) and MFA_RATE_LIMITED is thrown without verifying.
   */
  async reserveMfaAttempt(id: string): Promise<void> {
    const key = this.mfaKey(id);
    await this.mfaRedis(async () => {
      const count = Number(
        await this.redis.eval("local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c", 1, `${key}:attempts`, CHALLENGE_TTL_SECONDS),
      );
      if (count > MFA_MAX_ATTEMPTS) {
        await this.redis.del(key, `${key}:pending`);
        throw new MfaRateLimitedException(1);
      }
    });
  }

  /** After a wrong code: once all MFA_MAX_ATTEMPTS reserved attempts are used the challenge is deleted (login must restart). */
  async failMfaAttempt(id: string): Promise<void> {
    const key = this.mfaKey(id);
    await this.mfaRedis(async () => {
      const count = Number((await this.redis.get(`${key}:attempts`)) ?? 0);
      if (count >= MFA_MAX_ATTEMPTS) await this.redis.del(key, `${key}:pending`);
    });
  }

  /** Pending (not yet confirmed) TOTP secret of an enroll challenge, already sealed by the caller. Replaces any earlier one. */
  async setMfaPending(id: string, sealed: string): Promise<void> {
    await this.mfaRedis(() => this.redis.set(`${this.mfaKey(id)}:pending`, sealed, 'EX', CHALLENGE_TTL_SECONDS));
  }

  getMfaPending(id: string): Promise<string | null> {
    return this.mfaRedis(() => this.redis.get(`${this.mfaKey(id)}:pending`));
  }

  private stepUpKey(id: string): string {
    return `auth:stepup:${sha256(id)}`;
  }

  /** Opaque 256-bit id; the binding lives only in Redis for CHALLENGE_TTL_SECONDS. */
  async issueStepUp(binding: StepUpBinding): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    await this.mfaRedis(() => this.redis.set(this.stepUpKey(id), JSON.stringify(binding), 'EX', CHALLENGE_TTL_SECONDS));
    return id;
  }

  /**
   * Atomically counts one attempt (INCR+EXPIRE+GET in one Lua script, so parallel requests cannot overshoot
   * MFA_MAX_ATTEMPTS), then checks the binding. Unknown/expired/exhausted/mismatching => MfaChallengeInvalidException.
   * Does not consume: call consumeStepUp after the proof succeeded.
   */
  async checkStepUp(id: string, expected: StepUpBinding): Promise<void> {
    const key = this.stepUpKey(id);
    const raw = await this.mfaRedis(() =>
      this.redis.eval(
        "local c = redis.call('INCR', KEYS[2]) if c == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end if c > tonumber(ARGV[2]) then redis.call('DEL', KEYS[1]) return false end return redis.call('GET', KEYS[1])",
        2,
        key,
        `${key}:attempts`,
        CHALLENGE_TTL_SECONDS,
        MFA_MAX_ATTEMPTS,
      ),
    );
    if (typeof raw !== 'string' || !stepUpMatches(raw, expected)) throw new MfaChallengeInvalidException();
  }

  /** Atomic single-use consumption (GETDEL): exactly one concurrent caller wins; everyone else gets MfaChallengeInvalidException. */
  async consumeStepUp(id: string, expected: StepUpBinding): Promise<void> {
    const key = this.stepUpKey(id);
    const raw = await this.mfaRedis(() => this.redis.getdel(key));
    if (!raw || !stepUpMatches(raw, expected)) throw new MfaChallengeInvalidException();
    await this.mfaRedis(() => this.redis.del(`${key}:attempts`));
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
