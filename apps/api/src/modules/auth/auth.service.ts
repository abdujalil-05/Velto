import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { systemPrisma, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AccessTokenPayload } from '../../common/auth/auth.types';
import {
  AccountBlockedException,
  InvalidCredentialsException,
  SessionExpiredException,
} from '../../common/auth/auth-exceptions';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { TelegramAuthDto } from './dto/telegram-auth.dto';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { verifyTelegramInitData } from './telegram-init-data';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface PublicUser {
  id: string;
  firstName: string;
  lastName: string;
  roles: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

interface MinimalUser {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const TELEGRAM_API = 'https://api.telegram.org';

// Telegram's contact.phone_number comes back in whatever format the user's
// device/client produced (with or without "+", spaces, dashes) — normalize
// to the "+998XXXXXXXXX" shape UZ_PHONE_RE / every seeded User.phone uses,
// or return null if it isn't a recognizable Uzbek mobile number (fails
// closed to "no match" rather than guessing).
function normalizeUzPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  if (digits.length === 9) return `+998${digits}`;
  return null;
}

/** Minimal shape of a Telegram Bot API Update — only the fields the contact-share webhook needs. */
export interface TelegramWebhookUpdate {
  message?: {
    from?: { id: number };
    contact?: { phone_number: string; user_id?: number };
  };
}

export function parseDurationMs(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(input);
  if (!match) {
    throw new Error(`Invalid duration string: "${input}" (expected e.g. "15m", "30d")`);
  }
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return Number(match[1]) * multipliers[match[2] as keyof typeof multipliers];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly rateLimiter: LoginRateLimiterService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * 15.2: "login'da companyId so'ralmaydi". Since User.phone is only unique
   * per-company (schema 6.2), the same phone could in theory belong to a
   * user in more than one tenant — resolved here by trying the password
   * against every candidate rather than asking the client to pick a tenant.
   */
  async login(dto: LoginDto, meta: RequestMeta): Promise<TokenPair> {
    await this.rateLimiter.assertNotBlocked(dto.phone);

    const candidates = await systemPrisma.user.findMany({ where: { phone: dto.phone, isActive: true } });

    // Verified in parallel rather than sequentially-with-early-exit: a
    // ketma-ket loop leaks how many tenants share dto.phone through response
    // time (N candidates ~ N sequential argon2.verify calls). Running them
    // concurrently ties latency to the slowest single verify instead of the
    // count, closing most of that channel.
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        const ok = candidate.passwordHash && (await argon2.verify(candidate.passwordHash, dto.password));
        return ok ? candidate : undefined;
      }),
    );
    const authenticated = results.find((candidate) => candidate !== undefined);

    if (!authenticated) {
      await this.rateLimiter.recordFailure(dto.phone);
      // SEC-054: "kirish ... rad etilishi ham yoziladi" — only logged against
      // real accounts (candidates.length > 0 means the phone matched at
      // least one active user, just with a wrong password); an unrecognized
      // phone has no tenant to scope an AuditLog row to, and the phone-keyed
      // rate limiter above already covers brute-forcing nonexistent numbers.
      await this.logFailedLogin(candidates, meta);
      throw new InvalidCredentialsException();
    }

    const company = await systemPrisma.company.findUnique({ where: { id: authenticated.companyId } });
    if (!company?.isActive) {
      await this.logFailedLogin([authenticated], meta);
      throw new AccountBlockedException();
    }

    await this.rateLimiter.recordSuccess(dto.phone);

    return this.tenantPrisma.run(authenticated.companyId, (tx) =>
      this.issueTokensInTx(tx, authenticated, meta, undefined, 'auth.login'),
    );
  }

  async telegramLogin(dto: TelegramAuthDto, meta: RequestMeta): Promise<TokenPair> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    let telegramId: bigint;
    try {
      const tgUser = verifyTelegramInitData(dto.initData, botToken);
      telegramId = BigInt(tgUser.id);
    } catch {
      throw new InvalidCredentialsException();
    }

    const user = await systemPrisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      // Unrecognized telegramId — no tenant to scope an AuditLog row to.
      throw new InvalidCredentialsException();
    }
    if (!user.isActive) {
      await this.logFailedLogin([user], meta);
      throw new InvalidCredentialsException();
    }

    const company = await systemPrisma.company.findUnique({ where: { id: user.companyId } });
    if (!company?.isActive) {
      await this.logFailedLogin([user], meta);
      throw new AccountBlockedException();
    }

    return this.tenantPrisma.run(user.companyId, (tx) =>
      this.issueTokensInTx(tx, user, meta, undefined, 'auth.login.telegram'),
    );
  }

  /**
   * Links a User.telegramId the first time an agent shares their phone from
   * the Mini App (Telegram.WebApp.requestContact()) — Telegram delivers that
   * share to the bot as a normal message with a `contact` field, not to the
   * Mini App's JS directly, hence a webhook rather than a request/response
   * pair. Always resolves (never throws) — Telegram retries a webhook call
   * that doesn't 200, and every failure mode here is either "nothing to do"
   * or "best-effort user notification failed", neither worth a retry storm.
   */
  async linkTelegramContact(update: TelegramWebhookUpdate): Promise<void> {
    const contact = update.message?.contact;
    const from = update.message?.from;
    if (!contact || !from) return;

    // Telegram's request_contact keyboard only lets a user share their own
    // number, but this is the one link between "whose phone" and "whose
    // Telegram account" that a User.telegramId write hinges on — worth
    // checking rather than trusting the client-side guarantee alone.
    if (contact.user_id !== undefined && contact.user_id !== from.id) return;

    const phone = normalizeUzPhone(contact.phone_number);
    if (!phone) return;

    const telegramId = BigInt(from.id);
    const candidates = await systemPrisma.user.findMany({ where: { phone } });

    if (candidates.length !== 1) {
      // 0 matches: no such User yet (admin hasn't created them). >1 matches:
      // phone is only unique per-company (schema 6.2), so this Telegram
      // account can't be auto-linked to one of several companies without
      // guessing — fail closed either way, just tell the user why.
      await this.replyTelegram(
        telegramId,
        candidates.length === 0
          ? "Bu raqam Velto tizimida topilmadi. Avval kompaniyangiz administratori sizni tizimga qo'shishi kerak."
          : 'Bu raqam bir nechta kompaniyada topildi. Administratoringiz bilan bog\'laning.',
      );
      return;
    }

    const [user] = candidates;
    if (user.telegramId === telegramId) {
      await this.replyTelegram(telegramId, "Siz allaqachon bog'langansiz. Ilovani qayta oching.");
      return;
    }
    if (user.telegramId !== null) {
      // Already linked to a *different* Telegram account — don't silently
      // reassign a login credential out from under someone.
      await this.replyTelegram(telegramId, "Bu raqam boshqa Telegram akkauntga bog'langan. Administratoringiz bilan bog'laning.");
      return;
    }

    await this.tenantPrisma.run(user.companyId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { telegramId } });
      await this.auditLog.log(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: 'auth.telegram_linked',
        entity: 'User',
        entityId: user.id,
      });
    });
    await this.replyTelegram(telegramId, "Bog'landi! Endi ilovani qayta oching.");
  }

  private async replyTelegram(chatId: bigint, text: string): Promise<void> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    if (!botToken) return;
    try {
      await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId.toString(), text }),
      });
    } catch {
      // best-effort — the link itself already succeeded/failed independently.
    }
  }

  async refresh(dto: { refreshToken: string }, meta: RequestMeta): Promise<TokenPair> {
    const tokenHash = hashToken(dto.refreshToken);
    const existing = await systemPrisma.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existing) {
      throw new SessionExpiredException();
    }

    if (existing.revokedAt) {
      // Reuse of an already-rotated token is a theft signal (15.2: "qayta
      // ishlatilsa butun oila bekor bo'ladi") — kill every token in the family.
      await this.tenantPrisma.run(existing.user.companyId, (tx) =>
        tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
      throw new SessionExpiredException();
    }

    if (existing.expiresAt < new Date()) {
      throw new SessionExpiredException();
    }
    if (!existing.user.isActive) {
      throw new AccountBlockedException();
    }

    const company = await systemPrisma.company.findUnique({ where: { id: existing.user.companyId } });
    if (!company?.isActive) {
      throw new AccountBlockedException();
    }

    return this.tenantPrisma.run(existing.user.companyId, async (tx) => {
      await tx.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
      return this.issueTokensInTx(tx, existing.user, meta, existing.familyId, 'auth.refresh');
    });
  }

  async logout(dto: { refreshToken: string; allDevices?: boolean }): Promise<void> {
    const tokenHash = hashToken(dto.refreshToken);
    const existing = await systemPrisma.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existing || existing.revokedAt) {
      return; // idempotent — already logged out
    }

    await this.tenantPrisma.run(existing.user.companyId, (tx) =>
      tx.refreshToken.updateMany({
        where: dto.allDevices ? { userId: existing.userId, revokedAt: null } : { id: existing.id },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** SEC-054: audits a rejected login attempt against every real account it matched. */
  private async logFailedLogin(users: { id: string; companyId: string }[], meta: RequestMeta): Promise<void> {
    for (const target of users) {
      await this.tenantPrisma.run(target.companyId, (tx) =>
        this.auditLog.log(tx, {
          companyId: target.companyId,
          userId: target.id,
          action: 'auth.login_failed',
          entity: 'User',
          entityId: target.id,
          ip: meta.ip,
        }),
      );
    }
  }

  private async issueTokensInTx(
    tx: TenantClient,
    user: MinimalUser,
    meta: RequestMeta,
    familyId: string = randomUUID(),
    auditAction: string,
  ): Promise<TokenPair> {
    const userRoles = await tx.userRole.findMany({ where: { userId: user.id }, include: { role: true } });
    const roles = userRoles.map((ur) => ur.role.code);

    const payload: AccessTokenPayload = { sub: user.id, companyId: user.companyId, roles };
    const accessToken = await this.jwtService.signAsync(payload);

    const refreshTokenValue = randomBytes(32).toString('hex');
    const refreshTtlMs = parseDurationMs(this.configService.get<string>('JWT_REFRESH_TTL', '30d'));

    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshTokenValue),
        familyId,
        expiresAt: new Date(Date.now() + refreshTtlMs),
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });

    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    await tx.auditLog.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        action: auditAction,
        entity: 'User',
        entityId: user.id,
        ip: meta.ip,
      },
    });

    return {
      accessToken,
      refreshToken: refreshTokenValue,
      user: { id: user.id, firstName: user.firstName, lastName: user.lastName, roles },
    };
  }
}
