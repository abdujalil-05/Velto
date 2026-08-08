import { createHash, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import type Redis from 'ioredis';
import { systemPrisma } from '@velto/database';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { SmsService } from '../../common/sms/sms.service';
import {
  PasswordResetCodeExpiredException,
  PasswordResetCodeInvalidException,
  PasswordResetCooldownException,
} from '../../common/auth/auth-exceptions';

const CODE_TTL_SECONDS = 5 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_REQUESTS_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

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
 * Self-service "forgot password" — a phone can belong to a User in more than
 * one company (phone is only unique per-company, schema 6.2), so — same
 * philosophy as AuthService.login()'s multi-tenant candidate search — one
 * SMS code resets the password for every active account sharing that phone,
 * rather than asking the user to pick a company up front.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly sms: SmsService,
  ) {}

  private codeKey(phone: string): string {
    return `pwreset:code:${phone}`;
  }
  private cooldownKey(phone: string): string {
    return `pwreset:cooldown:${phone}`;
  }
  private hourlyKey(phone: string): string {
    return `pwreset:hourly:${phone}`;
  }

  private async passwordCandidates(phone: string) {
    // Only users that actually have a password (agents authenticating via
    // Telegram initData alone, per CreateUserDto, have none — nothing to
    // reset for them, and login() itself skips them the same way).
    return systemPrisma.user.findMany({ where: { phone, isActive: true, passwordHash: { not: null } } });
  }

  /**
   * Always resolves without revealing whether `phone` matches an account
   * (avoids user enumeration) — rate-limited regardless of match so the
   * endpoint can't be used to SMS-bomb an arbitrary number.
   */
  async request(phone: string): Promise<void> {
    const cooldownTtl = await this.redis.ttl(this.cooldownKey(phone));
    if (cooldownTtl > 0) {
      throw new PasswordResetCooldownException(cooldownTtl);
    }

    const hourlyCount = await this.redis.incr(this.hourlyKey(phone));
    if (hourlyCount === 1) {
      await this.redis.expire(this.hourlyKey(phone), 3600);
    }
    if (hourlyCount > MAX_REQUESTS_PER_HOUR) {
      const ttl = await this.redis.ttl(this.hourlyKey(phone));
      throw new PasswordResetCooldownException(Math.max(ttl, 1));
    }

    // Cooldown is set unconditionally (even for a non-matching phone) so the
    // no-match path takes the same amount of "SMS budget" as a real one —
    // otherwise a no-match response coming back instantly would itself leak
    // which phones are registered.
    await this.redis.set(this.cooldownKey(phone), '1', 'EX', RESEND_COOLDOWN_SECONDS);

    const candidates = await this.passwordCandidates(phone);
    if (candidates.length === 0) return;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const stored: StoredCode = { codeHash: hashCode(phone, code), attempts: 0 };
    await this.redis.set(this.codeKey(phone), JSON.stringify(stored), 'EX', CODE_TTL_SECONDS);

    await this.sms.send(phone, `Velto: parolni tiklash kodi — ${code}. Kodni hech kimga aytmang.`);

    for (const user of candidates) {
      await this.tenantPrisma.run(user.companyId, (tx) =>
        this.auditLog.log(tx, {
          companyId: user.companyId,
          userId: user.id,
          action: 'auth.password_reset_requested',
          entity: 'User',
          entityId: user.id,
        }),
      );
    }
  }

  async confirm(phone: string, code: string, newPassword: string): Promise<void> {
    const raw = await this.redis.get(this.codeKey(phone));
    if (!raw) {
      throw new PasswordResetCodeExpiredException();
    }

    const stored = JSON.parse(raw) as StoredCode;
    if (stored.attempts >= MAX_VERIFY_ATTEMPTS) {
      await this.redis.del(this.codeKey(phone));
      throw new PasswordResetCodeExpiredException();
    }

    if (stored.codeHash !== hashCode(phone, code)) {
      stored.attempts += 1;
      const ttl = await this.redis.ttl(this.codeKey(phone));
      await this.redis.set(this.codeKey(phone), JSON.stringify(stored), 'EX', Math.max(ttl, 1));
      throw new PasswordResetCodeInvalidException(MAX_VERIFY_ATTEMPTS - stored.attempts);
    }

    await this.redis.del(this.codeKey(phone));

    const candidates = await this.passwordCandidates(phone);
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    for (const user of candidates) {
      await this.tenantPrisma.run(user.companyId, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
        // 15.2 "barcha qurilmadan logout" — a password reset is a full
        // credential rotation, so every existing session must die with it,
        // same as AuthController's own allDevices logout.
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
}
