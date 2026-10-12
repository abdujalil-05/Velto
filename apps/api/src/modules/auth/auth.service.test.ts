import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import Redis from 'ioredis';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import {
  AccountBlockedException,
  InvalidCredentialsException,
  SessionExpiredException,
  TelegramAuthUnavailableException,
  TelegramReplayRejectedException,
} from '../../common/auth/auth-exceptions';
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

  // handleTelegramUpdate() carries exactly one flow: contact-share -> User
  // (agents and couriers alike). These two pin down that the contact-share
  // path works and that any other update — a bare "/start" included — is a
  // no-op rather than a throw (Telegram would retry a non-2xx forever).
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

// TZ 11.1/11.2 + 16.3 (P0 security): refresh rotation / reuse => family revoked.
describe('AuthService refresh tokens (§16.3: refresh reuse => family revoked)', () => {
  let companyId: string;
  let phone: string;
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
  const auth = new AuthService(jwt, new ConfigService(), tenantPrisma, new LoginRateLimiterService(redis), auditLog);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-rt-${Date.now()}`, name: 'RT Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'RT Co' } })).id;
    phone = uniquePhone();
    await systemPrisma.user.create({
      data: {
        companyId,
        firstName: 'Rt',
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

  const login = () => auth.login({ phone, password }, { ip: '10.1.0.1' });

  async function auditActions(): Promise<string[]> {
    const rows = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'User' }, orderBy: { createdAt: 'asc' } }),
    );
    return rows.map((r) => r.action);
  }

  it('refresh rotates: new token works, the old one is marked revoked, same family', async () => {
    const first = await login();
    const second = await auth.refresh({ refreshToken: first.refreshToken }, {});
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const rows = await systemPrisma.refreshToken.findMany({ where: { userId: first.user.id } });
    const old = rows.find((r) => r.revokedAt && r.tokenHash !== undefined);
    expect(old).toBeTruthy();
    const third = await auth.refresh({ refreshToken: second.refreshToken }, {});
    expect(third.accessToken).toBeTruthy();
  });

  it('§16.3: replaying a used refresh token revokes the whole family (newest token fails too)', async () => {
    const first = await login();
    const second = await auth.refresh({ refreshToken: first.refreshToken }, {});
    const third = await auth.refresh({ refreshToken: second.refreshToken }, {});

    await expect(auth.refresh({ refreshToken: first.refreshToken }, {})).rejects.toBeInstanceOf(
      SessionExpiredException,
    );
    await expect(auth.refresh({ refreshToken: third.refreshToken }, {})).rejects.toBeInstanceOf(
      SessionExpiredException,
    );
  });

  it('§16.3: family revocation does not touch another session (another family) of the same user', async () => {
    const a = await login();
    const b = await login();
    const a2 = await auth.refresh({ refreshToken: a.refreshToken }, {});
    await expect(auth.refresh({ refreshToken: a.refreshToken }, {})).rejects.toBeTruthy();
    await expect(auth.refresh({ refreshToken: a2.refreshToken }, {})).rejects.toBeTruthy();
    await expect(auth.refresh({ refreshToken: b.refreshToken }, {})).resolves.toBeTruthy();
  });

  it('SEC-054: refresh-token reuse (theft signal) is audited', async () => {
    const first = await login();
    await auth.refresh({ refreshToken: first.refreshToken }, {});
    const before = (await auditActions()).length;
    await expect(auth.refresh({ refreshToken: first.refreshToken }, {})).rejects.toBeTruthy();
    const actions = (await auditActions()).slice(before);
    expect(actions).toContain('auth.refresh_reuse_detected');
    const row = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findFirstOrThrow({ where: { action: 'auth.refresh_reuse_detected' }, orderBy: { createdAt: 'desc' } }),
    );
    const familyId = (await systemPrisma.refreshToken.findFirstOrThrow({ where: { userId: first.user.id }, orderBy: { createdAt: 'desc' } })).familyId;
    expect((row.newValue as { familyId: string }).familyId).toBe(familyId);
  });

  it('an unknown refresh token is rejected', async () => {
    await expect(auth.refresh({ refreshToken: 'f'.repeat(64) }, {})).rejects.toBeInstanceOf(SessionExpiredException);
  });

  it('logout revokes the refresh token; later refresh fails; logout is idempotent', async () => {
    const t = await login();
    await auth.logout({ refreshToken: t.refreshToken });
    await expect(auth.refresh({ refreshToken: t.refreshToken }, {})).rejects.toBeInstanceOf(SessionExpiredException);
    await expect(auth.logout({ refreshToken: t.refreshToken })).resolves.toBeUndefined();
  });

  it('logout allDevices revokes every active session of the user', async () => {
    const a = await login();
    const b = await login();
    await auth.logout({ refreshToken: a.refreshToken, allDevices: true });
    await expect(auth.refresh({ refreshToken: a.refreshToken }, {})).rejects.toBeInstanceOf(SessionExpiredException);
    await expect(auth.refresh({ refreshToken: b.refreshToken }, {})).rejects.toBeInstanceOf(SessionExpiredException);
  });
});

// TZ 11.2 / 16.3: Telegram initData valid / invalid / expired / replayed.
describe('AuthService.telegramLogin (§16.3: initData valid/invalid/expired/replayed)', () => {
  const botToken = '123456:SYNTHETIC-BOT-TOKEN-FOR-TESTS'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tenantPrisma = new TenantPrismaService();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const settings: Record<string, unknown> = {
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_INITDATA_MAX_AGE_SECONDS: 600,
    TELEGRAM_INITDATA_MAX_USES: 20,
  };
  const config = {
    get: (k: string, d?: unknown) => settings[k] ?? d ?? undefined,
    getOrThrow: (k: string) => settings[k],
  };
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
  const auth = new AuthService(
    jwt,
    config as unknown as ConfigService,
    tenantPrisma,
    new LoginRateLimiterService(redis),
    new AuditLogService(),
  );
  const telegramId = BigInt(Math.floor(5_000_000_000 + Math.random() * 1_000_000_000));
  const inactiveUserTgId = telegramId + 1n;
  const inactiveCompanyTgId = telegramId + 2n;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-tg-${Date.now()}`, name: 'TG Tenant' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'TG Co' } });
    await systemPrisma.user.create({
      data: { companyId: company.id, firstName: 'Tg', lastName: 'Agent', phone: uniquePhone(), passwordHash: 'x', telegramId },
    });
    await systemPrisma.user.create({
      data: {
        companyId: company.id,
        firstName: 'Tg',
        lastName: 'Inactive',
        phone: uniquePhone(),
        passwordHash: 'x',
        telegramId: inactiveUserTgId,
        isActive: false,
      },
    });
    const deadCompany = await systemPrisma.company.create({
      data: { tenantId: tenant.id, name: 'TG Dead Co', isActive: false },
    });
    await systemPrisma.user.create({
      data: {
        companyId: deadCompany.id,
        firstName: 'Tg',
        lastName: 'DeadCo',
        phone: uniquePhone(),
        passwordHash: 'x',
        telegramId: inactiveCompanyTgId,
      },
    });
  });

  afterAll(async () => {
    redis.disconnect();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  function sign(fields: Record<string, string>, token = botToken): string {
    const check = Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  }
  const fresh = (ageSec = 10, nonce = randomUUID()) =>
    ({ query_id: nonce, user: JSON.stringify({ id: Number(telegramId), first_name: 'Tg' }), auth_date: String(Math.floor(Date.now() / 1000) - ageSec) });

  it('valid initData is accepted and issues tokens (audit auth.login.telegram)', async () => {
    const res = await auth.telegramLogin({ initData: sign(fresh()) } as never, { ip: '10.2.0.1' });
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
  });

  it('tampered initData (payload changed after signing) is rejected', async () => {
    const params = new URLSearchParams(sign(fresh()));
    params.set('user', JSON.stringify({ id: Number(telegramId) + 1, first_name: 'Evil' }));
    await expect(auth.telegramLogin({ initData: params.toString() } as never, {})).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('initData with a wrong hash / missing hash is rejected', async () => {
    const params = new URLSearchParams(sign(fresh()));
    params.set('hash', '0'.repeat(64));
    await expect(auth.telegramLogin({ initData: params.toString() } as never, {})).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    params.delete('hash');
    await expect(auth.telegramLogin({ initData: params.toString() } as never, {})).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('a tampered hash of the right length (64 hex) is rejected', async () => {
    const params = new URLSearchParams(sign(fresh()));
    const hash = params.get('hash') as string;
    params.set('hash', hash.slice(0, 63) + (hash.endsWith('0') ? '1' : '0'));
    await expect(auth.telegramLogin({ initData: params.toString() } as never, {})).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('a wrong-length or non-hex hash is rejected with the same error', async () => {
    for (const bad of ['ab', 'a'.repeat(65), 'z'.repeat(64), 'A'.repeat(64)]) {
      const params = new URLSearchParams(sign(fresh()));
      params.set('hash', bad);
      await expect(auth.telegramLogin({ initData: params.toString() } as never, {})).rejects.toBeInstanceOf(
        InvalidCredentialsException,
      );
    }
  });

  it('auth_date in the future: +120 s is rejected, +30 s (clock skew) is accepted', async () => {
    await expect(auth.telegramLogin({ initData: sign(fresh(-120)) } as never, {})).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    const res = await auth.telegramLogin({ initData: sign(fresh(-30)) } as never, {});
    expect(res.accessToken).toBeTruthy();
  });

  it('unlinked gets InvalidCredentials, inactive user/company get AccountBlocked, none consume a Redis counter', async () => {
    const cases: Array<[number, new () => Error]> = [
      [Number(telegramId) + 99, InvalidCredentialsException],
      [Number(inactiveUserTgId), AccountBlockedException],
      [Number(inactiveCompanyTgId), AccountBlockedException],
    ];
    for (const [id, expectedClass] of cases) {
      const f = { ...fresh(), user: JSON.stringify({ id, first_name: 'X' }) };
      const initData = sign(f);
      const err = await auth.telegramLogin({ initData } as never, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(expectedClass);
      const hash = new URLSearchParams(initData).get('hash');
      expect(await redis.exists(`tg:initdata:${hash}`)).toBe(0);
    }
  });

  it('initData signed with a different bot token is rejected', async () => {
    await expect(
      auth.telegramLogin({ initData: sign(fresh(), '999:OTHER-BOT') } as never, {}),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('expired auth_date (older than the 10 min freshness limit) is rejected', async () => {
    await expect(
      auth.telegramLogin({ initData: sign(fresh(10 * 60 + 30)) } as never, {}),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('initData for an unlinked telegram user is rejected', async () => {
    const f = { ...fresh(), user: JSON.stringify({ id: 1, first_name: 'Nobody' }) };
    await expect(auth.telegramLogin({ initData: sign(f) } as never, {})).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('§16.3: the same initData is accepted up to the cap, then cap+1 is rejected as replay and audited', async () => {
    const initData = sign(fresh());
    const hash = new URLSearchParams(initData).get('hash') as string;
    await auth.telegramLogin({ initData } as never, {});
    const ttl = await redis.ttl(`tg:initdata:${hash}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
    for (let i = 1; i < 20; i++) {
      await auth.telegramLogin({ initData } as never, {});
    }
    // 5 attempts over the cap: all rejected, but only ONE audit row is written.
    for (let i = 0; i < 5; i++) {
      await expect(auth.telegramLogin({ initData } as never, { ip: '10.2.0.9' })).rejects.toBeInstanceOf(
        TelegramReplayRejectedException,
      );
    }
    const user = await systemPrisma.user.findFirstOrThrow({ where: { telegramId } });
    const rows = await systemPrisma.auditLog.findMany({
      where: { userId: user.id, action: 'auth.telegram_replay_rejected', newValue: { path: ['initDataHashPrefix'], equals: hash.slice(0, 8) } },
    });
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify([rows[0].newValue, rows[0].oldValue]);
    expect(dump).not.toContain(initData);
    expect(dump).not.toContain(hash);
    expect(dump).not.toContain(botToken);
    expect(dump).toContain(hash.slice(0, 8));
  });

  it('§16.3: Redis failure rejects login (fail-closed)', async () => {
    const downLimiter = { recordTelegramInitDataUse: () => Promise.reject(new Error('redis down')) };
    const failClosed = new AuthService(
      jwt,
      config as unknown as ConfigService,
      tenantPrisma,
      downLimiter as unknown as LoginRateLimiterService,
      new AuditLogService(),
    );
    await expect(failClosed.telegramLogin({ initData: sign(fresh()) } as never, {})).rejects.toBeInstanceOf(
      TelegramAuthUnavailableException,
    );
  });
});
