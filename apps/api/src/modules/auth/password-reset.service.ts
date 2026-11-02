import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import type Redis from 'ioredis';
import { systemPrisma } from '@velto/database';
import { failClosedOnRedis } from '../../common/redis/redis-unavailable';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AuthChallengeStore } from './auth-challenge.store';
import { SmsService } from '../../common/sms/sms.service';
import {
  AuthChallengeInvalidException,
  PasswordResetCodeExpiredException,
  PasswordResetCodeInvalidException,
  PasswordResetCooldownException,
} from '../../common/auth/auth-exceptions';

const CODE_TTL_SECONDS = 5 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_REQUESTS_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

export interface AccountSelectionRequired {
  requiresAccountSelection: true;
  resetHandle: string;
  accounts: { id: string; name: string }[];
}

interface StoredCode {
  codeHash: string;
  attempts: number;
}

function hashCode(phone: string, code: string): string {
  // Phone is mixed into the hash so a leaked Redis dump can't be replayed
  // against a different phone's key.
  return createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

/**
 * Self-service "forgot password" (ADR-057a). A phone can belong to Users in
 * several companies (schema 6.2); the SMS code only proves phone ownership,
 * then — if several accounts match — the client picks exactly one.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordResetService');

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly sms: SmsService,
    private readonly challenges: AuthChallengeStore,
  ) {}

  private codeKey(phone: string): string {
    return `pwreset:code:${phone}`;
  }
  private cooldownKey(phone: string): string {
    return `pwreset:cooldown:${phone}`;
  }
  private attemptsKey(phone: string): string {
    return `pwreset:attempts:${phone}`;
  }
  private hourlyKey(phone: string): string {
    return `pwreset:hourly:${phone}`;
  }

  /** Every Redis call fails closed with 503 SERVICE_UNAVAILABLE when Redis is down (ADR-050): no OTP issued/verified without the limiter. */
  private readonly store = {
    ttl: (k: string) => failClosedOnRedis(() => this.redis.ttl(k)),
    incr: (k: string) => failClosedOnRedis(() => this.redis.incr(k)),
    expire: (k: string, s: number) => failClosedOnRedis(() => this.redis.expire(k, s)),
    get: (k: string) => failClosedOnRedis(() => this.redis.get(k)),
    del: (k: string) => failClosedOnRedis(() => this.redis.del(k)),
    set: (k: string, v: string, mode: 'EX', ttl: number) => failClosedOnRedis(() => this.redis.set(k, v, mode, ttl)),
  };

  private async passwordCandidates(phone: string) {
    // Only users that actually have a password (agents authenticating via
    // Telegram initData alone, per CreateUserDto, have none — nothing to
    // reset for them, and login() itself skips them the same way).
    return systemPrisma.user.findMany({
      where: { phone, isActive: true, passwordHash: { not: null }, company: { isActive: true } },
      include: { company: { select: { name: true } } },
    });
  }

  /**
   * Always resolves without revealing whether `phone` matches an account
   * (avoids user enumeration) — rate-limited regardless of match so the
   * endpoint can't be used to SMS-bomb an arbitrary number.
   */
  async request(phone: string): Promise<void> {
    // Pilot without an SMS provider: disabled uniformly (503 SMS_NOT_CONFIGURED) before any
    // limiter/lookup, so it never reports success for an SMS that cannot be sent.
    this.sms.assertAvailable();
    const cooldownTtl = await this.store.ttl(this.cooldownKey(phone));
    if (cooldownTtl > 0) {
      throw new PasswordResetCooldownException(cooldownTtl);
    }

    const hourlyCount = await this.store.incr(this.hourlyKey(phone));
    if (hourlyCount === 1) {
      await this.store.expire(this.hourlyKey(phone), 3600);
    }
    if (hourlyCount > MAX_REQUESTS_PER_HOUR) {
      const ttl = await this.store.ttl(this.hourlyKey(phone));
      throw new PasswordResetCooldownException(Math.max(ttl, 1));
    }

    // Cooldown is set unconditionally (even for a non-matching phone) so the
    // no-match path takes the same amount of "SMS budget" as a real one —
    // otherwise a no-match response coming back instantly would itself leak
    // which phones are registered.
    await this.store.set(this.cooldownKey(phone), '1', 'EX', RESEND_COOLDOWN_SECONDS);

    const candidates = await this.passwordCandidates(phone);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const stored: StoredCode = { codeHash: hashCode(phone, code), attempts: 0 };
    await this.store.set(this.codeKey(phone), JSON.stringify(stored), 'EX', CODE_TTL_SECONDS);
    await this.store.del(this.attemptsKey(phone));
    // Unknown phone: a decoy code is stored (never sent) so confirm() behaves
    // identically for known and unknown numbers (no enumeration via attempts/expiry).
    if (candidates.length === 0) return;

    // Not awaited: SMS gateway + audit latency would otherwise tell a known
    // phone (and its account count) from an unknown one. deliver() never rejects.
    void this.deliver(phone, code, candidates);
  }

  private async deliver(phone: string, code: string, candidates: { id: string; companyId: string }[]): Promise<void> {
    try {
      await this.sms.send(phone, `Velto: parolni tiklash kodi — ${code}. Kodni hech kimga aytmang.`);
    } catch (err) {
      // Logged, not thrown: a gateway failure must not surface to the client
      // (user enumeration); the caller can request a new code after the cooldown.
      this.logger.error(`Password reset SMS delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const user of candidates) {
      try {
        await this.tenantPrisma.run(user.companyId, (tx) =>
          this.auditLog.log(tx, {
            companyId: user.companyId,
            userId: user.id,
            action: 'auth.password_reset_requested',
            entity: 'User',
            entityId: user.id,
          }),
        );
      } catch (err) {
        this.logger.error(`Password reset audit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Step 2 (ADR-057a): proves phone ownership with the OTP (single-use, TTL,
   * attempt-limited). One account => password changed (returns undefined,
   * 204). Several => NOTHING changes yet; the company list is revealed only
   * now (after proof) together with a single-use server-bound handle for
   * selectAccount(). No session is ever issued by a reset.
   */
  async confirm(phone: string, code: string, newPassword: string): Promise<AccountSelectionRequired | undefined> {
    const raw = await this.store.get(this.codeKey(phone));
    if (!raw) {
      throw new PasswordResetCodeExpiredException();
    }

    // Atomic INCR *before* comparing: parallel guesses each get a distinct
    // counter value, so at most MAX_VERIFY_ATTEMPTS of them ever reach the compare.
    const attempts = await this.store.incr(this.attemptsKey(phone));
    if (attempts === 1) {
      await this.store.expire(this.attemptsKey(phone), CODE_TTL_SECONDS);
    }
    if (attempts > MAX_VERIFY_ATTEMPTS) {
      await this.store.del(this.codeKey(phone));
      throw new PasswordResetCodeExpiredException();
    }

    const stored = JSON.parse(raw) as StoredCode;
    if (stored.codeHash !== hashCode(phone, code)) {
      throw new PasswordResetCodeInvalidException(MAX_VERIFY_ATTEMPTS - attempts);
    }

    // DEL is the atomic claim: of two concurrent correct confirms only one gets 1.
    if ((await this.store.del(this.codeKey(phone))) !== 1) {
      throw new PasswordResetCodeExpiredException();
    }

    const candidates = await this.passwordCandidates(phone);
    if (candidates.length === 0) {
      throw new PasswordResetCodeExpiredException();
    }
    if (candidates.length === 1) {
      await this.changePassword(candidates[0], newPassword);
      return undefined;
    }

    const options = candidates.map((u) => ({ optionId: randomBytes(16).toString('base64url'), userId: u.id, companyId: u.companyId }));
    const resetHandle = await this.challenges.issue({ kind: 'reset_account', stage: 'select_company', phone, options });
    return {
      requiresAccountSelection: true,
      resetHandle,
      accounts: candidates.map((u, i) => ({ id: options[i].optionId, name: u.company.name })),
    };
  }

  /** Step 3 (several accounts): password and session revocation apply ONLY to the chosen account. */
  async selectAccount(dto: { resetHandle: string; optionId: string; newPassword: string }, ip?: string): Promise<void> {
    await this.challenges.hit('reset-select-ip', ip ?? 'unknown', 10, 5 * 60);
    const challenge = await this.challenges.consume(dto.resetHandle, 'reset_account');
    const option = challenge.options.find((o) => o.optionId === dto.optionId);
    if (!option) throw new AuthChallengeInvalidException();

    const user = await systemPrisma.user.findFirst({
      where: { id: option.userId, companyId: option.companyId, phone: challenge.phone, isActive: true, passwordHash: { not: null }, company: { isActive: true } },
    });
    if (!user) throw new AuthChallengeInvalidException();
    await this.changePassword(user, dto.newPassword);
  }

  private async changePassword(user: { id: string; companyId: string }, newPassword: string): Promise<void> {
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.tenantPrisma.run(user.companyId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // 15.2 "barcha qurilmadan logout" — credential rotation kills this account's sessions only.
      await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.auditLog.log(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: 'auth.password_reset_completed',
        entity: 'User',
        entityId: user.id,
      });
    });
  }
}
