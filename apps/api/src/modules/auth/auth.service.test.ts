import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import Redis from 'ioredis';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { AccountBlockedException, InvalidCredentialsException } from '../../common/auth/auth-exceptions';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AuthService } from './auth.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';

// +998 followed by 9 digits, matching UZ_PHONE_RE in login.dto.ts. Random per
// call (not a fixed literal) so concurrently-running test files can never
// collide on the same phone — User.phone is only unique *per company*
// (schema 6.2), so two different companies legitimately can share a phone,
// and login() intentionally searches across all of them (15.2: "login'da
// companyId so'ralmaydi").
function uniquePhone(): string {
  return `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}`;
}

describe('AuthService (integration, real Postgres + Redis)', () => {
  let companyId: string;
  let phone: string;
  // Test-fixture password for a throwaway user this file creates and
  // deletes itself — not a real credential.
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const rateLimiter = new LoginRateLimiterService(redis);
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
  const config = new ConfigService();
  const auth = new AuthService(jwt, config, tenantPrisma, rateLimiter, auditLog);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-auth-${Date.now()}`, name: 'Auth Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Auth Test Co' } });
    companyId = company.id;
    phone = uniquePhone();

    await systemPrisma.user.create({
      data: {
        companyId,
        firstName: 'Auth',
        lastName: 'User',
        phone,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      },
    });
  });

  afterAll(async () => {
    redis.disconnect();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function lastAuditAction(scopeCompanyId: string): Promise<string | undefined> {
    const entry = await tenantPrisma.run(scopeCompanyId, (tx) =>
      tx.auditLog.findFirst({ where: { entity: 'User' }, orderBy: { createdAt: 'desc' } }),
    );
    return entry?.action;
  }

  it('a correct password issues tokens and audits "auth.login"', async () => {
    const result = await auth.login({ phone, password }, { ip: '10.0.0.1' });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(await lastAuditAction(companyId)).toBe('auth.login');
  });

  it('SEC-054: a wrong password is rejected and audited as "auth.login_failed"', async () => {
    await expect(auth.login({ phone, password: 'wrong-password' }, { ip: '10.0.0.2' })).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(await lastAuditAction(companyId)).toBe('auth.login_failed');
  });

  it('an unrecognized phone is rejected without touching AuditLog (no tenant to scope it to)', async () => {
    const before = await lastAuditAction(companyId);
    await expect(
      auth.login({ phone: uniquePhone(), password: 'whatever12' }, { ip: '10.0.0.3' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(await lastAuditAction(companyId)).toBe(before); // unchanged — nothing new written
  });

  it('a deactivated company rejects login and audits "auth.login_failed"', async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-auth-blocked-${Date.now()}`, name: 'Blocked Tenant' },
    });
    const blockedCompany = await systemPrisma.company.create({
      data: { tenantId: tenant.id, name: 'Blocked Co', isActive: false },
    });
    const blockedPhone = uniquePhone();
    await systemPrisma.user.create({
      data: {
        companyId: blockedCompany.id,
        firstName: 'Blocked',
        lastName: 'User',
        phone: blockedPhone,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      },
    });

    await expect(auth.login({ phone: blockedPhone, password }, { ip: '10.0.0.4' })).rejects.toBeInstanceOf(
      AccountBlockedException,
    );
    expect(await lastAuditAction(blockedCompany.id)).toBe('auth.login_failed');
  });

  it('SEC-010..019: blocks outright once the failure count reaches the 10-attempt threshold', async () => {
    const bruteforcePhone = uniquePhone();
    await systemPrisma.user.create({
      data: {
        companyId,
        firstName: 'Brute',
        lastName: 'Force',
        phone: bruteforcePhone,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      },
    });
    // Seed the Redis failure counter directly to the documented BLOCK_AFTER
    // threshold (login-rate-limiter.service.ts) instead of looping through
    // 10 real attempts — that path is exercised for a handful of failures by
    // the "wrong password" test above; this test only needs to prove
    // AuthService.login() actually consults LoginRateLimiterService and
    // blocks, without paying for the real per-attempt backoff delays.
    await redis.set(`login:fail:${bruteforcePhone}`, '10', 'EX', 900);

    // Even the *correct* password is rejected outright once blocked.
    await expect(auth.login({ phone: bruteforcePhone, password }, {})).rejects.toThrow();
  });
});

describe('AuthService.linkTelegramContact (integration, real Postgres + RLS)', () => {
  let companyId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const config = new ConfigService();
  const auth = new AuthService(
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } }),
    config,
    tenantPrisma,
    new LoginRateLimiterService(new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')),
    auditLog,
  );

  // Random rather than sequential (like uniquePhone() above) — test data
  // from prior runs isn't truncated between invocations, so a fixed counter
  // would collide with User.telegramId's global unique constraint.
  function fakeTelegramId(): number {
    return 900_000_000 + Math.floor(Math.random() * 99_000_000);
  }

  async function createUser(phone: string, telegramId: bigint | null = null) {
    return systemPrisma.user.create({
      data: { companyId, firstName: 'Agent', lastName: 'Test', phone, telegramId, isActive: true },
    });
  }

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-link-${Date.now()}`, name: 'Link Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Link Test Co' } });
    companyId = company.id;
  });

  // replyTelegram() fires on most branches below and ConfigService falls
  // through to process.env, where the repo's .env carries a *real*
  // TELEGRAM_BOT_TOKEN — without this stub these tests would hit
  // api.telegram.org for every fixture chat id.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('links telegramId when exactly one User matches the shared phone', async () => {
    const phone = uniquePhone();
    const user = await createUser(phone);
    const tgId = fakeTelegramId();

    await auth.linkTelegramContact({
      message: { from: { id: tgId }, contact: { phone_number: phone, user_id: tgId } },
    });

    const updated = await systemPrisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.telegramId).toBe(BigInt(tgId));

    const audit = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findFirst({ where: { entityId: user.id, action: 'auth.telegram_linked' } }),
    );
    expect(audit).toBeTruthy();
  });

  it('normalizes a phone_number without a leading "+" before matching', async () => {
    const phone = uniquePhone(); // "+998XXXXXXXX"
    const user = await createUser(phone);
    const tgId = fakeTelegramId();

    await auth.linkTelegramContact({
      message: { from: { id: tgId }, contact: { phone_number: phone.slice(1), user_id: tgId } }, // drop the "+"
    });

    const updated = await systemPrisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.telegramId).toBe(BigInt(tgId));
  });

  it('does nothing when contact.user_id does not match the sender (not sharing their own number)', async () => {
    const phone = uniquePhone();
    const user = await createUser(phone);
    const tgId = fakeTelegramId();

    await auth.linkTelegramContact({
      message: { from: { id: tgId }, contact: { phone_number: phone, user_id: fakeTelegramId() } },
    });

    const updated = await systemPrisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.telegramId).toBeNull();
  });

  it('does nothing when no User has that phone', async () => {
    const tgId = fakeTelegramId();
    await expect(
      auth.linkTelegramContact({
        message: { from: { id: tgId }, contact: { phone_number: uniquePhone(), user_id: tgId } },
      }),
    ).resolves.not.toThrow();
  });

  it('does not overwrite an existing link to a different Telegram account', async () => {
    const phone = uniquePhone();
    const originalTgId = fakeTelegramId();
    const user = await createUser(phone, BigInt(originalTgId));
    const newTgId = fakeTelegramId();

    await auth.linkTelegramContact({
      message: { from: { id: newTgId }, contact: { phone_number: phone, user_id: newTgId } },
    });

    const updated = await systemPrisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.telegramId).toBe(BigInt(originalTgId));
  });

  it('is idempotent when the same Telegram account re-shares its already-linked phone', async () => {
    const phone = uniquePhone();
    const tgId = fakeTelegramId();
    const user = await createUser(phone, BigInt(tgId));

    await expect(
      auth.linkTelegramContact({
        message: { from: { id: tgId }, contact: { phone_number: phone, user_id: tgId } },
      }),
    ).resolves.not.toThrow();

    const updated = await systemPrisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.telegramId).toBe(BigInt(tgId));
  });

  // The webhook now multiplexes two flows (contact-share -> User,
  // "/start <code>" -> Supplier) through handleTelegramUpdate(); these two
  // pin down that the original contact-share path is unchanged and that a
  // bare "/start" is still the no-op it always was.
  it('handleTelegramUpdate still links a shared contact', async () => {
    const phone = uniquePhone();
    const user = await createUser(phone);
    const tgId = fakeTelegramId();

    await auth.handleTelegramUpdate({
      message: { from: { id: tgId }, contact: { phone_number: phone, user_id: tgId } },
    });

    expect((await systemPrisma.user.findUnique({ where: { id: user.id } }))?.telegramId).toBe(BigInt(tgId));
  });

  it('handleTelegramUpdate treats a bare /start as a no-op', async () => {
    await expect(
      auth.handleTelegramUpdate({ message: { from: { id: fakeTelegramId() }, text: '/start' } }),
    ).resolves.toBeUndefined();
  });

  it('does not link when the phone is ambiguous across more than one company', async () => {
    const phone = uniquePhone();
    const userA = await createUser(phone);

    const otherTenant = await systemPrisma.tenant.create({
      data: { slug: `test-link-b-${Date.now()}`, name: 'Link Test Tenant B' },
    });
    const otherCompany = await systemPrisma.company.create({
      data: { tenantId: otherTenant.id, name: 'Link Test Co B' },
    });
    const userB = await systemPrisma.user.create({
      data: { companyId: otherCompany.id, firstName: 'Agent', lastName: 'B', phone, isActive: true },
    });

    const tgId = fakeTelegramId();
    await auth.linkTelegramContact({
      message: { from: { id: tgId }, contact: { phone_number: phone, user_id: tgId } },
    });

    expect((await systemPrisma.user.findUnique({ where: { id: userA.id } }))?.telegramId).toBeNull();
    expect((await systemPrisma.user.findUnique({ where: { id: userB.id } }))?.telegramId).toBeNull();
  });
});
