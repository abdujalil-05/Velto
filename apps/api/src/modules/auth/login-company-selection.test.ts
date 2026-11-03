import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import Redis from 'ioredis';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import {
  AuthChallengeInvalidException,
  InvalidCredentialsException,
} from '../../common/auth/auth-exceptions';
import { ServiceUnavailableAppException } from '../../common/redis/redis-unavailable';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AuthChallengeStore } from './auth-challenge.store';
import { AuthService, type CompanySelectionRequired, type TokenPair } from './auth.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';

const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const rndIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const uniquePhone = () => `+998${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe('ADR-057 login company selection (real Postgres + Redis)', () => {
  const tenantPrisma = new TenantPrismaService();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  // Redis that is never reachable: challenge store must fail closed.
  const deadRedis = new Redis({ port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
  const build = (store: AuthChallengeStore) =>
    new AuthService(jwt, new ConfigService(), tenantPrisma, new LoginRateLimiterService(redis), new AuditLogService(), store);
  const auth = build(new AuthChallengeStore(redis));

  let coA: { id: string; name: string };
  let coB: { id: string; name: string };
  let coInactive: { id: string; name: string };
  let hash: string;

  async function company(name: string, isActive = true) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `t-sel-${name}-${Date.now()}-${randomInt(1e6)}`, name } });
    return systemPrisma.company.create({ data: { tenantId: tenant.id, name, isActive } });
  }
  const mkUser = (companyId: string, phone: string, extra: Record<string, unknown> = {}) =>
    systemPrisma.user.create({ data: { companyId, firstName: 'S', lastName: 'U', phone, passwordHash: hash, ...extra } });
  const keyOf = (id: string) => `auth:challenge:${createHash('sha256').update(id).digest('hex')}`;
  // login() audits failures fire-and-forget; wait for the write so it can't land after cleanup.
  const failedAudited = (u: { id: string; companyId: string }) =>
    vi.waitFor(async () => {
      const row = await tenantPrisma.run(u.companyId, (tx) =>
        tx.auditLog.findFirst({ where: { entityId: u.id, action: 'auth.login_failed' } }),
      );
      expect(row).not.toBeNull();
    });
  const multi = async (phone: string) => (await auth.login({ phone, password }, { ip: '10.2.0.1' })) as CompanySelectionRequired;

  beforeAll(async () => {
    hash = await argon2.hash(password, { type: argon2.argon2id });
    coA = await company('SelA');
    coB = await company('SelB');
    coInactive = await company('SelOff', false);
  });
  afterAll(async () => {
    redis.disconnect();
    deadRedis.disconnect();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('single match logs in as before', async () => {
    const phone = uniquePhone();
    await mkUser(coA.id, phone);
    const r = (await auth.login({ phone, password }, {})) as TokenPair;
    expect(r.accessToken).toBeTruthy();
  });

  it('wrong password and unknown phone give the same generic error; unknown phone still runs a dummy argon2 verify', async () => {
    const phone = uniquePhone();
    const wrongPwUser = await mkUser(coA.id, phone);
    const spy = vi.spyOn(argon2, 'verify');
    await expect(auth.login({ phone, password: 'nope-nope-nope' }, {})).rejects.toBeInstanceOf(InvalidCredentialsException);
    await failedAudited(wrongPwUser);
    spy.mockClear();
    await expect(auth.login({ phone: uniquePhone(), password }, {})).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(spy).toHaveBeenCalledTimes(3); // padded to MIN_VERIFY_SLOTS
    spy.mockClear();
    const nullHashPhone = uniquePhone();
    const nullHashUser = await mkUser(coA.id, nullHashPhone, { passwordHash: null });
    await expect(auth.login({ phone: nullHashPhone, password }, {})).rejects.toBeInstanceOf(InvalidCredentialsException);
    await failedAudited(nullHashUser);
    expect(spy).toHaveBeenCalledTimes(3); // padded to MIN_VERIFY_SLOTS
    spy.mockRestore();
  });

  it('several matches: no tokens, opaque challenge, only matching companies (no companyId leak)', async () => {
    const phone = uniquePhone();
    await mkUser(coA.id, phone);
    await mkUser(coB.id, phone);
    await mkUser(coB.id, uniquePhone()); // unrelated account must not appear
    const r = await multi(phone);
    expect(r.requiresCompanySelection).toBe(true);
    expect('accessToken' in r).toBe(false);
    expect(r.companies.map((c) => c.name).sort()).toEqual(['SelA', 'SelB']);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain(coA.id);
    expect(dump).not.toContain(coB.id);
    // stored under SHA-256(id), not the raw id
    expect(await redis.exists(keyOf(r.challengeId))).toBe(1);
    expect(await redis.exists(`auth:challenge:${r.challengeId}`)).toBe(0);
    expect(await redis.ttl(keyOf(r.challengeId))).toBeLessThanOrEqual(300);
  });

  it('selection issues tokens for the chosen company only; replay is rejected', async () => {
    const phone = uniquePhone();
    await mkUser(coA.id, phone);
    const b = await mkUser(coB.id, phone);
    const r = await multi(phone);
    const optB = r.companies.find((c) => c.name === 'SelB')!;
    const tokens = (await auth.selectCompany({ challengeId: r.challengeId, optionId: optB.id }, { ip: rndIp() })) as TokenPair;
    expect(tokens.user.id).toBe(b.id);
    await expect(auth.selectCompany({ challengeId: r.challengeId, optionId: optB.id }, { ip: rndIp() })).rejects.toBeInstanceOf(
      AuthChallengeInvalidException,
    );
  });

  it('inactive company does not block another active account and does not appear', async () => {
    const phone = uniquePhone();
    await mkUser(coInactive.id, phone);
    await mkUser(coA.id, phone);
    const r = (await auth.login({ phone, password }, {})) as TokenPair;
    expect(r.accessToken).toBeTruthy(); // exactly one usable match => plain login
  });

  it('only inactive company => generic invalid credentials', async () => {
    const phone = uniquePhone();
    const inactiveUser = await mkUser(coInactive.id, phone);
    await expect(auth.login({ phone, password }, {})).rejects.toBeInstanceOf(InvalidCredentialsException);
    await failedAudited(inactiveUser);
  });

  it('forged option / foreign challenge / garbage are rejected, and the challenge is burned', async () => {
    const phone = uniquePhone();
    await mkUser(coA.id, phone);
    await mkUser(coB.id, phone);
    const r = await multi(phone);
    const other = uniquePhone();
    await mkUser(coA.id, other);
    await mkUser(coB.id, other);
    const r2 = await multi(other);
    // option of challenge 2 presented with challenge 1
    await expect(auth.selectCompany({ challengeId: r.challengeId, optionId: r2.companies[0].id }, { ip: rndIp() })).rejects.toBeInstanceOf(
      AuthChallengeInvalidException,
    );
    // challenge 1 is consumed even by a failed attempt
    await expect(auth.selectCompany({ challengeId: r.challengeId, optionId: r.companies[0].id }, { ip: rndIp() })).rejects.toBeInstanceOf(
      AuthChallengeInvalidException,
    );
    // raw companyId as option, random challenge id
    await expect(auth.selectCompany({ challengeId: r2.challengeId, optionId: coA.id.padEnd(22, 'x') }, { ip: rndIp() })).rejects.toBeInstanceOf(
      AuthChallengeInvalidException,
    );
    await expect(auth.selectCompany({ challengeId: 'x'.repeat(43), optionId: 'y'.repeat(22) }, { ip: rndIp() })).rejects.toBeInstanceOf(
      AuthChallengeInvalidException,
    );
  });

  it('expired challenge is rejected', async () => {
    const phone = uniquePhone();
    await mkUser(coA.id, phone);
    await mkUser(coB.id, phone);
    const r = await multi(phone);
    await redis.pexpire(keyOf(r.challengeId), 1);
    await new Promise((res) => setTimeout(res, 30));
    await expect(auth.selectCompany({ challengeId: r.challengeId, optionId: r.companies[0].id }, { ip: rndIp() })).rejects.toBeInstanceOf(
      AuthChallengeInvalidException,
    );
  });

  it('user or company deactivated between login and selection is rejected', async () => {
    const phone = uniquePhone();
    const uA = await mkUser(coA.id, phone);
    await mkUser(coB.id, phone);
    const r = await multi(phone);
    await systemPrisma.user.update({ where: { id: uA.id }, data: { isActive: false } });
    const optA = r.companies.find((c) => c.name === 'SelA')!;
    await expect(auth.selectCompany({ challengeId: r.challengeId, optionId: optA.id }, { ip: rndIp() })).rejects.toBeInstanceOf(
      AuthChallengeInvalidException,
    );
  });

  it('Redis down: multi-match login and selection fail closed (503), no tokens', async () => {
    const phone = uniquePhone();
    await mkUser(coA.id, phone);
    await mkUser(coB.id, phone);
    const down = build(new AuthChallengeStore(deadRedis));
    await expect(down.login({ phone, password }, {})).rejects.toBeInstanceOf(ServiceUnavailableAppException);
    await expect(down.selectCompany({ challengeId: 'x'.repeat(43), optionId: 'y'.repeat(22) }, { ip: rndIp() })).rejects.toBeInstanceOf(
      ServiceUnavailableAppException,
    );
  });

  it('selection is rate limited per IP', async () => {
    const ip = `10.9.${randomInt(255)}.${randomInt(255)}`;
    for (let i = 0; i < 10; i++) {
      await expect(auth.selectCompany({ challengeId: 'x'.repeat(43), optionId: 'y'.repeat(22) }, { ip })).rejects.toBeInstanceOf(
        AuthChallengeInvalidException,
      );
    }
    await expect(auth.selectCompany({ challengeId: 'x'.repeat(43), optionId: 'y'.repeat(22) }, { ip })).rejects.toMatchObject({
      response: { code: 'AUTH_CHALLENGE_RATE_LIMITED' },
    });
  });

  it('audits issuance and the selected login inside the right tenant only (cross-tenant isolation)', async () => {
    const phone = uniquePhone();
    const uA = await mkUser(coA.id, phone);
    const uB = await mkUser(coB.id, phone);
    const r = await multi(phone);
    await auth.selectCompany({ challengeId: r.challengeId, optionId: r.companies.find((c) => c.name === 'SelA')!.id }, { ip: rndIp() });
    const rowsA = await tenantPrisma.run(coA.id, (tx) => tx.auditLog.findMany({ where: { entityId: { in: [uA.id, uB.id] } } }));
    const rowsB = await tenantPrisma.run(coB.id, (tx) => tx.auditLog.findMany({ where: { entityId: { in: [uA.id, uB.id] } } }));
    expect(rowsA.map((x) => x.action).sort()).toEqual(['auth.login', 'auth.login_company_selection_issued']);
    expect(rowsA.every((x) => x.entityId === uA.id)).toBe(true);
    expect(rowsB.map((x) => x.action)).toEqual(['auth.login_company_selection_issued']);
    expect(rowsB[0].entityId).toBe(uB.id);
  });
});
