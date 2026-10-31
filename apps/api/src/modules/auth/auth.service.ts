import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { systemPrisma, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AccessTokenPayload } from '../../common/auth/auth.types';
import { isMfaSessionValid, requiresMfa } from '../../common/auth/mfa-policy';
import {
  AccountBlockedException,
  AuthChallengeInvalidException,
  InvalidCredentialsException,
  MfaRequiredException,
  MfaWebLoginRequiredException,
  SessionExpiredException,
  TelegramAuthUnavailableException,
  TelegramReplayRejectedException,
} from '../../common/auth/auth-exceptions';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { TelegramAuthDto } from './dto/telegram-auth.dto';
import { AuthChallengeStore, CHALLENGE_TTL_SECONDS } from './auth-challenge.store';
import type { SelectCompanyDto } from './dto/select-company.dto';
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

const SELECT_MAX_PER_WINDOW = 10;
const SELECT_WINDOW_SECONDS = 5 * 60;

export interface CompanySelectionRequired {
  requiresCompanySelection: true;
  challengeId: string;
  companies: { id: string; name: string }[];
}

/** ADR-058: returned instead of tokens when the user's roles require TOTP. `mfa` says which step the client must run. */
export interface MfaStepRequired {
  mfa: 'verify' | 'enroll';
  mfaChallenge: string;
  expiresIn: number;
}

// Fixed number of argon2 verifies per login attempt (see login()).
const MIN_VERIFY_SLOTS = 3;

// Verified when no real hash exists so response time doesn't reveal account existence (ADR-057).
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });
  return dummyHashPromise;
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

/** Minimal shape of a Telegram Bot API Update — only the fields the webhook needs. */
export interface TelegramWebhookUpdate {
  message?: {
    from?: { id: number; username?: string };
    text?: string;
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
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly rateLimiter: LoginRateLimiterService,
    private readonly auditLog: AuditLogService,
    private readonly challenges: AuthChallengeStore,
  ) {}

  /**
   * 15.2 + ADR-057: "login'da companyId so'ralmaydi". User.phone is unique only
   * per company, so the password is verified against EVERY active candidate
   * for the phone (a dummy argon2 hash stands in when there is none or the
   * hash is null, so latency doesn't reveal existence). Accounts whose company
   * is inactive are silently dropped: they neither block another active
   * account nor reveal themselves (same generic error as a wrong password).
   * One match => tokens; several => no tokens, an opaque challenge plus only
   * the matching companies (id = opaque option id, name).
   */
  async login(dto: LoginDto, meta: RequestMeta): Promise<TokenPair | MfaStepRequired | CompanySelectionRequired> {
    await this.rateLimiter.assertNotBlocked(dto.phone);

    const candidates = await systemPrisma.user.findMany({
      where: { phone: dto.phone, isActive: true },
      include: { company: { select: { id: true, name: true, isActive: true } } },
    });

    // Sequential (parallel verifies beyond the libuv pool size queue and leak N),
    // padded with dummy-hash verifies up to MIN_VERIFY_SLOTS so timing is flat for
    // 0..MIN_VERIFY_SLOTS candidates; beyond the cap each extra candidate must still be verified.
    const dummyHash = await getDummyHash();
    const verifications: (typeof candidates[number] | undefined)[] = [];
    for (let i = 0; i < Math.max(candidates.length, MIN_VERIFY_SLOTS); i++) {
      const candidate = candidates[i];
      const ok = await argon2.verify(candidate?.passwordHash ?? dummyHash, dto.password);
      verifications.push(candidate?.passwordHash && ok ? candidate : undefined);
    }
    const matches = verifications.filter(
      (c): c is NonNullable<typeof c> => c !== undefined && c.company.isActive,
    );

    if (matches.length === 0) {
      await this.rateLimiter.recordFailure(dto.phone);
      // SEC-054: only real accounts can be audited (unknown phone has no tenant).
      // Not awaited: N audit transactions would leak the candidate count by latency.
      void this.logFailedLogin(candidates, meta).catch((err) =>
        this.logger.error(`Failed-login audit failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      throw new InvalidCredentialsException();
    }

    await this.rateLimiter.recordSuccess(dto.phone);

    if (matches.length === 1) {
      const [user] = matches;
      return this.completeLogin(user, meta, 'auth.login');
    }

    const options = matches.map((m) => ({ optionId: randomBytes(16).toString('base64url'), userId: m.id, companyId: m.companyId }));
    const challengeId = await this.challenges.issue({ kind: 'login_company', stage: 'select_company', phone: dto.phone, options });
    for (const m of matches) {
      await this.tenantPrisma.run(m.companyId, (tx) =>
        this.auditLog.log(tx, {
          companyId: m.companyId,
          userId: m.id,
          action: 'auth.login_company_selection_issued',
          entity: 'User',
          entityId: m.id,
          ip: meta.ip,
        }),
      );
    }
    return {
      requiresCompanySelection: true,
      challengeId,
      companies: matches.map((m, i) => ({ id: options[i].optionId, name: m.company.name })),
    };
  }

  /**
   * ADR-057: second step of a multi-company login. The option must belong to
   * the challenge (server-side); the challenge is consumed (GETDEL) whatever
   * the outcome. User and company are re-checked as still active.
   */
  async selectCompany(dto: SelectCompanyDto, meta: RequestMeta): Promise<TokenPair | MfaStepRequired> {
    await this.challenges.hit('select-ip', meta.ip ?? 'unknown', SELECT_MAX_PER_WINDOW, SELECT_WINDOW_SECONDS);
    const challenge = await this.challenges.consume(dto.challengeId, 'login_company');
    const option = challenge.options.find((o) => o.optionId === dto.optionId);
    if (!option) throw new AuthChallengeInvalidException();

    const user = await systemPrisma.user.findUnique({
      where: { id: option.userId },
      include: { company: { select: { isActive: true } } },
    });
    if (!user || user.companyId !== option.companyId || !user.isActive || !user.company.isActive) {
      if (user) await this.logFailedLogin([user], meta);
      throw new AuthChallengeInvalidException();
    }
    return this.completeLogin(user, meta, 'auth.login');
  }

  /**
   * The single place where a password-authenticated user either gets a session or,
   * if their CURRENT roles require MFA (ADR-058), an MFA challenge instead of any token.
   */
  private async completeLogin(user: MinimalUser, meta: RequestMeta, auditAction: string): Promise<TokenPair | MfaStepRequired> {
    const outcome = await this.tenantPrisma.run<TokenPair | MfaStepRequired['mfa']>(user.companyId, async (tx) => {
      const { roles, confirmedMfaId } = await this.loadMfaState(tx, user.id);
      if (!requiresMfa(roles)) return this.issueTokensInTx(tx, user, meta, undefined, auditAction);
      return confirmedMfaId ? 'verify' : 'enroll';
    });
    if (typeof outcome === 'object') return outcome;
    const mfaChallenge = await this.challenges.issueMfa({
      scope: outcome === 'verify' ? 'mfa_verify' : 'mfa_enroll',
      userId: user.id,
      companyId: user.companyId,
      replacesMfaId: null,
    });
    return { mfa: outcome, mfaChallenge, expiresIn: CHALLENGE_TTL_SECONDS };
  }

  /** The user's current role codes and the id of their CONFIRMED UserMfa (null if none). */
  private async loadMfaState(tx: TenantClient, userId: string): Promise<{ roles: string[]; confirmedMfaId: string | null }> {
    const [userRoles, mfa] = await Promise.all([
      tx.userRole.findMany({ where: { userId }, include: { role: { select: { code: true } } } }),
      tx.userMfa.findFirst({ where: { userId, confirmedAt: { not: null } }, select: { id: true } }),
    ]);
    return { roles: userRoles.map((ur) => ur.role.code), confirmedMfaId: mfa?.id ?? null };
  }

  async telegramLogin(dto: TelegramAuthDto, meta: RequestMeta): Promise<TokenPair> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    // Defaults live in env.schema.ts only.
    const maxAgeSeconds = Number(this.configService.getOrThrow('TELEGRAM_INITDATA_MAX_AGE_SECONDS'));
    const maxUses = Number(this.configService.getOrThrow('TELEGRAM_INITDATA_MAX_USES'));

    let telegramId: bigint;
    let initDataHash: string;
    try {
      const { user: tgUser, hash } = verifyTelegramInitData(dto.initData, botToken, maxAgeSeconds);
      telegramId = BigInt(tgUser.id);
      initDataHash = hash;
    } catch {
      throw new InvalidCredentialsException();
    }

    // telegramId is unique per *company*, not globally (schema 6.2 — a global
    // unique would be a cross-tenant constraint), so this lookup is a findMany
    // that fails closed on anything other than exactly one hit, mirroring the
    // phone-lookup path below. In practice linkTelegram() refuses to create a
    // second link, so >1 should be unreachable; if it ever happens there is no
    // safe way to guess which company the agent meant.
    const candidates = await systemPrisma.user.findMany({ where: { telegramId } });
    if (candidates.length !== 1) {
      // Unrecognized (or ambiguous) telegramId — no tenant to scope an
      // AuditLog row to.
      throw new InvalidCredentialsException();
    }
    const [user] = candidates;

    if (!user.isActive) {
      await this.logFailedLogin([user], meta);
      throw new AccountBlockedException();
    }

    const company = await systemPrisma.company.findUnique({ where: { id: user.companyId } });
    if (!company?.isActive) {
      await this.logFailedLogin([user], meta);
      throw new AccountBlockedException();
    }

    // ADR-058: initData is never a second factor — privileged roles must use the web login with TOTP.
    const { roles: telegramRoles } = await this.tenantPrisma.run(user.companyId, (tx) => this.loadMfaState(tx, user.id));
    if (requiresMfa(telegramRoles)) {
      await this.tenantPrisma.run(user.companyId, (tx) =>
        this.auditLog.log(tx, {
          companyId: user.companyId,
          userId: user.id,
          action: 'auth.mfa.denied',
          entity: 'User',
          entityId: user.id,
          newValue: { channel: 'telegram' },
          ip: meta.ip,
        }),
      );
      throw new MfaWebLoginRequiredException();
    }

    // Counted only after signature, freshness and user/company checks passed (garbage can't burn a cap).
    // Fail-closed: if Redis is down the replay check can't run, so login is refused.
    let useCount: number;
    try {
      useCount = await this.rateLimiter.recordTelegramInitDataUse(initDataHash, maxAgeSeconds);
    } catch {
      throw new TelegramAuthUnavailableException();
    }
    if (useCount > maxUses) {
      // Audit once per hash per window (append-only table must not be floodable).
      if (useCount === maxUses + 1) {
        await this.tenantPrisma.run(user.companyId, (tx) =>
          this.auditLog.log(tx, {
            companyId: user.companyId,
            userId: user.id,
            action: 'auth.telegram_replay_rejected',
            entity: 'User',
            entityId: user.id,
            newValue: { initDataHashPrefix: initDataHash.slice(0, 8) },
            ip: meta.ip,
          }),
        );
      }
      throw new TelegramReplayRejectedException();
    }

    return this.tenantPrisma.run(user.companyId, (tx) =>
      this.issueTokensInTx(tx, user, meta, undefined, 'auth.login.telegram'),
    );
  }

  /**
   * Single entry point for every Telegram Bot API update the webhook receives.
   * Only one linking flow remains: a shared contact links a `User` — agents
   * and couriers alike, since a courier is an ordinary User carrying the
   * COURIER role. Anything else (a bare `/start`, plain text) is a no-op; the
   * welcome text is BotFather-configured, not sent from this handler.
   * Like `linkTelegramContact` it never throws — Telegram retries any non-2xx.
   */
  async handleTelegramUpdate(update: TelegramWebhookUpdate): Promise<void> {
    if (update.message?.contact) {
      await this.linkTelegramContact(update);
    }
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

    // telegramId is only unique per company now, so the database no longer
    // stops one Telegram account from being linked in two companies at once —
    // which would make the telegram login lookup above ambiguous and lock the
    // account out. Enforce the "one Telegram account = one Velto user"
    // invariant here instead. `systemPrisma` is correct for this specific
    // check: it is a cross-tenant question asked before a companyId is known,
    // the same reason the phone lookup above uses it.
    const alreadyLinked = await systemPrisma.user.findFirst({ where: { telegramId }, select: { id: true } });
    if (alreadyLinked) {
      await this.replyTelegram(telegramId, "Bu Telegram akkaunt boshqa foydalanuvchiga bog'langan. Administratoringiz bilan bog'laning.");
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

    // Owner state first: a deactivated/blocked account's tokens are revoked by
    // design (users.deactivate), so that is NOT a reuse signal. 403 is only
    // reachable by presenting a valid token hash, so it leaks nothing to others.
    if (!existing.user.isActive) {
      throw new AccountBlockedException();
    }
    const company = await systemPrisma.company.findUnique({ where: { id: existing.user.companyId } });
    if (!company?.isActive) {
      throw new AccountBlockedException();
    }

    if (existing.revokedAt) {
      // Reuse of an already-rotated token is a theft signal (15.2: "qayta
      // ishlatilsa butun oila bekor bo'ladi") — kill every token in the family.
      // SEC-054: audited in the same (separately committed) transaction as the
      // revocation, before the SessionExpired error below is thrown.
      await this.tenantPrisma.run(existing.user.companyId, async (tx) => {
        await tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.auditLog.log(tx, {
          companyId: existing.user.companyId,
          userId: existing.userId,
          action: 'auth.refresh_reuse_detected',
          entity: 'User',
          entityId: existing.userId,
          newValue: { familyId: existing.familyId },
          ip: meta.ip,
        });
      });
      throw new SessionExpiredException();
    }

    if (existing.expiresAt < new Date()) {
      throw new SessionExpiredException();
    }

    const rotated = await this.tenantPrisma.run(existing.user.companyId, async (tx) => {
      // ADR-058: a privileged user's family survives only while it is backed by their current confirmed MFA.
      const { roles, confirmedMfaId } = await this.loadMfaState(tx, existing.userId);
      if (!isMfaSessionValid(roles, confirmedMfaId, existing.mfaId)) {
        await tx.refreshToken.updateMany({ where: { familyId: existing.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.auditLog.log(tx, {
          companyId: existing.user.companyId,
          userId: existing.userId,
          action: 'auth.mfa.denied',
          entity: 'User',
          entityId: existing.userId,
          newValue: { channel: 'refresh' },
          ip: meta.ip,
        });
        return undefined;
      }
      await tx.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
      return this.issueTokensInTx(tx, existing.user, meta, existing.familyId, 'auth.refresh', existing.mfaId);
    });
    if (!rotated) throw new MfaRequiredException();
    return rotated;
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

  /** `mfaId` = confirmed UserMfa this session is backed by (ADR-058): stored on the refresh token and signed into the access token. */
  async issueTokensInTx(
    tx: TenantClient,
    user: MinimalUser,
    meta: RequestMeta,
    familyId: string = randomUUID(),
    auditAction: string,
    mfaId: string | null = null,
  ): Promise<TokenPair> {
    const userRoles = await tx.userRole.findMany({ where: { userId: user.id }, include: { role: true } });
    const roles = userRoles.map((ur) => ur.role.code);

    const payload: AccessTokenPayload = { sub: user.id, companyId: user.companyId, roles, sid: familyId, ...(mfaId ? { mfa: mfaId } : {}) };
    const accessToken = await this.jwtService.signAsync(payload);

    const refreshTokenValue = randomBytes(32).toString('hex');
    const refreshTtlMs = parseDurationMs(this.configService.get<string>('JWT_REFRESH_TTL', '30d'));

    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshTokenValue),
        familyId,
        mfaId,
        expiresAt: new Date(Date.now() + refreshTtlMs),
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });

    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: auditAction,
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
    });

    return {
      accessToken,
      refreshToken: refreshTokenValue,
      user: { id: user.id, firstName: user.firstName, lastName: user.lastName, roles },
    };
  }
}
