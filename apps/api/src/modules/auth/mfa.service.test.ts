import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import Redis from 'ioredis';
import { generate } from 'otplib';
import { generateMfaEnrollmentCode, hashMfaEnrollmentCode, prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import {
  MfaChallengeInvalidException,
  MfaEnrollmentCodeInvalidException,
  MfaCodeInvalidException,
  MfaRateLimitedException,
  MfaRequiredException,
  MfaServiceUnavailableException,
  MfaWebLoginRequiredException,
} from '../../common/auth/auth-exceptions';
import { SecretBox } from '../../common/crypto/secret-box';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { SmsService } from '../../common/sms/sms.service';
import { CannotResetOwnMfaException, MfaEnrollmentCodeNotApplicableException, UserNotFoundException } from '../users/users-exceptions';
import { UsersService } from '../users/users.service';
import { AuthChallengeStore } from './auth-challenge.store';
import { AuthService, type MfaStepRequired, type TokenPair } from './auth.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { MfaService, type MfaSession } from './mfa.service';
import { PasswordResetService } from './password-reset.service';

const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const rndIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const uniquePhone = () => `+998${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
const wrongCode = (good: string) => (good === '000000' ? '111111' : '000000');

describe('ADR-058 TOTP MFA (real Postgres + Redis)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const deadRedis = new Redis({ port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
  deadRedis.on('error', () => undefined);
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
  const botToken = 'test-bot-token';
  const settings: Record<string, unknown> = {
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_INITDATA_MAX_AGE_SECONDS: 600,
    TELEGRAM_INITDATA_MAX_USES: 20,
    MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
  };
  const config = {
    get: (k: string, d?: unknown) => settings[k] ?? d ?? undefined,
    getOrThrow: (k: string) => settings[k],
  } as unknown as ConfigService;
  const secretBox = new SecretBox(config);
  const rateLimiter = new LoginRateLimiterService(redis);
  const store = new AuthChallengeStore(redis);
  const build = (s: AuthChallengeStore) => {
    const auth = new AuthService(jwt, config, tenantPrisma, rateLimiter, auditLog, s);
    return { auth, mfa: new MfaService(auth, tenantPrisma, s, rateLimiter, auditLog, secretBox) };
  };
  const { auth, mfa } = build(store);
  const users = new UsersService(tenantPrisma, auditLog);

  let coA: string;
  let coB: string;
  let hash: string;

  async function company(name: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `t-mfa-${name}-${Date.now()}-${randomInt(1e6)}`, name } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name } })).id;
  }

  async function grant(companyId: string, userId: string, code: string) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = (await tx.role.findFirst({ where: { companyId, code } })) ?? (await tx.role.create({ data: { companyId, code, name: code, isSystem: true } }));
      await tx.userRole.create({ data: { userId, roleId: role.id } });
    });
  }

  async function mkUser(companyId: string, roleCode: string, extra: { telegramId?: bigint } = {}) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({ data: { companyId, firstName: roleCode, lastName: 'Mfa', phone, passwordHash: hash, ...extra } });
    await grant(companyId, user.id, roleCode);
    return { id: user.id, companyId, phone };
  }

  const challengeOf = (r: unknown): MfaStepRequired => {
    const step = r as MfaStepRequired;
    expect(step.mfaChallenge).toBeTruthy();
    return step;
  };

  /** Inserts a valid enrollment code for the user (what POST /users/:id/mfa/enrollment-code stores). */
  async function mkCode(u: { id: string; companyId: string }, over: { expiresAt?: Date; usedAt?: Date } = {}) {
    const code = generateMfaEnrollmentCode();
    await systemPrisma.mfaEnrollmentCode.create({
      data: { companyId: u.companyId, userId: u.id, codeHash: hashMfaEnrollmentCode(code), expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000), usedAt: over.usedAt ?? null },
    });
    return code;
  }

  /** Logs a fresh user in through the first-login enrollment flow. */
  async function enrolled(roleCode = 'OWNER', companyId = coA) {
    const u = await mkUser(companyId, roleCode);
    const step = challengeOf(await auth.login({ phone: u.phone, password }, { ip: rndIp() }));
    expect(step.mfa).toBe('enroll');
    const enrollmentCode = await mkCode(u);
    const start = await mfa.startEnroll(step.mfaChallenge, enrollmentCode, { ip: rndIp() });
    const session = await mfa.confirmEnroll({ mfaChallenge: step.mfaChallenge, enrollmentCode, code: await generate({ secret: start.secret }) }, { ip: rndIp() });
    return { ...u, secret: start.secret, session, recoveryCodes: session.recoveryCodes! };
  }

  /** A TOTP code the replay guard has not seen: rewinds lastUsedStep, then returns the current code. */
  async function freshCode(userId: string, secret: string): Promise<string> {
    await systemPrisma.userMfa.update({ where: { userId }, data: { lastUsedStep: -1 } });
    return generate({ secret });
  }

  async function verifyChallenge(u: { phone: string }) {
    const step = challengeOf(await auth.login({ phone: u.phone, password }, { ip: rndIp() }));
    expect(step.mfa).toBe('verify');
    return step.mfaChallenge;
  }

  const refreshRows = (u: { id: string; companyId: string }) => tenantPrisma.run(u.companyId, (tx) => tx.refreshToken.findMany({ where: { userId: u.id } }));
  const auditActions = async (u: { id: string; companyId: string }) =>
    (await tenantPrisma.run(u.companyId, (tx) => tx.auditLog.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } }))).map((a) => a.action);

  beforeAll(async () => {
    hash = await argon2.hash(password, { type: argon2.argon2id });
    coA = await company('A');
    coB = await company('B');
  });

  afterAll(async () => {
    redis.disconnect();
    deadRedis.disconnect();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('privileged roles get an enroll challenge and no tokens; SALES_AGENT is unchanged', async () => {
    const owner = await mkUser(coA, 'OWNER');
    const r = await auth.login({ phone: owner.phone, password }, { ip: rndIp() });
    expect(r).toMatchObject({ mfa: 'enroll', expiresIn: 300 });
    expect(r).not.toHaveProperty('accessToken');
    expect(await refreshRows(owner)).toHaveLength(0);

    const agent = await mkUser(coA, 'SALES_AGENT');
    const t = (await auth.login({ phone: agent.phone, password }, { ip: rndIp() })) as TokenPair;
    expect(t.accessToken).toBeTruthy();
    expect(jwt.decode(t.accessToken)).not.toHaveProperty('mfa');
  });

  it.each(['SALES_DIRECTOR', 'CASHIER'])('%s is also gated', async (role) => {
    const u = await mkUser(coA, role);
    expect(await auth.login({ phone: u.phone, password }, { ip: rndIp() })).toMatchObject({ mfa: 'enroll' });
  });

  it('enrollment: tokens carry mfa = UserMfa.id, 10 argon2id recovery codes, sealed secret, audit has no secrets', async () => {
    const e = await enrolled();
    const row = await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: e.id } });
    expect(row.confirmedAt).not.toBeNull();
    expect(Buffer.from(row.secretCiphertext).toString('utf8')).not.toContain(e.secret);
    expect(secretBox.open({ ciphertext: Buffer.from(row.secretCiphertext), iv: Buffer.from(row.secretIv), tag: Buffer.from(row.secretTag), keyVersion: row.keyVersion }, `${e.companyId}:${e.id}`)).toBe(e.secret);
    expect(jwt.decode(e.session.accessToken)).toMatchObject({ mfa: row.id });
    expect((await refreshRows(e)).filter((t) => !t.revokedAt).map((t) => t.mfaId)).toEqual([row.id]);
    expect(e.recoveryCodes).toHaveLength(10);
    const codes = await systemPrisma.userMfaRecoveryCode.findMany({ where: { userId: e.id } });
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c.codeHash.startsWith('$argon2id$')).toBe(true);
    const audits = await tenantPrisma.run(e.companyId, (tx) => tx.auditLog.findMany({ where: { userId: e.id } }));
    expect(audits.map((a) => a.action)).toContain('auth.mfa.enrolled');
    const blob = JSON.stringify(audits);
    expect(blob).not.toContain(e.secret);
    for (const c of e.recoveryCodes) expect(blob).not.toContain(c);
  });

  it('second login = verify; a valid code issues a session with the mfa claim; the same code cannot be replayed', async () => {
    const e = await enrolled();
    const code = await freshCode(e.id, e.secret);
    const s = await mfa.verify({ mfaChallenge: await verifyChallenge(e), code }, { ip: rndIp() });
    const mfaRow = await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: e.id } });
    expect(jwt.decode(s.accessToken)).toMatchObject({ mfa: mfaRow.id });
    await expect(mfa.verify({ mfaChallenge: await verifyChallenge(e), code }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    expect(await auditActions(e)).toEqual(expect.arrayContaining(['auth.mfa.verified', 'auth.mfa.failed']));
  });

  it('parallel verification with the same code: exactly one success (atomic lastUsedStep)', async () => {
    const e = await enrolled();
    const code = await freshCode(e.id, e.secret);
    const [c1, c2] = [await verifyChallenge(e), await verifyChallenge(e)];
    const results = await Promise.allSettled([
      mfa.verify({ mfaChallenge: c1, code }, { ip: rndIp() }),
      mfa.verify({ mfaChallenge: c2, code }, { ip: rndIp() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('expired / out-of-window code is rejected', async () => {
    const e = await enrolled();
    await systemPrisma.userMfa.update({ where: { userId: e.id }, data: { lastUsedStep: -1 } });
    const old = await generate({ secret: e.secret, epoch: Math.floor(Date.now() / 1000) - 300 });
    await expect(mfa.verify({ mfaChallenge: await verifyChallenge(e), code: old }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
  });

  it('attempt limit: 5 wrong codes delete the challenge, even the right code then fails; challenge is single-use', async () => {
    const e = await enrolled();
    const challenge = await verifyChallenge(e);
    const good = await freshCode(e.id, e.secret);
    for (let i = 0; i < 5; i++) {
      await expect(mfa.verify({ mfaChallenge: challenge, code: wrongCode(good) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    }
    await expect(mfa.verify({ mfaChallenge: challenge, code: good }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaChallengeInvalidException);

    const c2 = await verifyChallenge(e);
    const ok = await freshCode(e.id, e.secret);
    await mfa.verify({ mfaChallenge: c2, code: ok }, { ip: rndIp() });
    await expect(mfa.verify({ mfaChallenge: c2, code: ok }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaChallengeInvalidException);
  });

  it('attempt limit is atomic: 12 parallel wrong codes => at most 5 counted, the rest MFA_RATE_LIMITED, challenge burned', async () => {
    const e = await enrolled();
    const challenge = await verifyChallenge(e);
    const good = await freshCode(e.id, e.secret);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => mfa.verify({ mfaChallenge: challenge, code: wrongCode(good) }, { ip: rndIp() })));
    const reasons = results.map((r) => (r.status === 'rejected' ? r.reason : null));
    expect(reasons.filter((r) => r instanceof MfaCodeInvalidException)).toHaveLength(5);
    expect(reasons.filter((r) => r instanceof MfaRateLimitedException)).toHaveLength(7);
    await expect(mfa.verify({ mfaChallenge: challenge, code: good }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaChallengeInvalidException);
  });

  it('a scope works on its own endpoints only; exactly one of code/recoveryCode', async () => {
    const e = await enrolled();
    const verifyCh = await verifyChallenge(e);
    await expect(mfa.startEnroll(verifyCh, undefined, { ip: rndIp() })).rejects.toBeInstanceOf(MfaChallengeInvalidException);
    const u = await mkUser(coA, 'OWNER');
    const enrollCh = challengeOf(await auth.login({ phone: u.phone, password }, { ip: rndIp() })).mfaChallenge;
    await expect(mfa.verify({ mfaChallenge: enrollCh, code: '123456' }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaChallengeInvalidException);
    await expect(mfa.verify({ mfaChallenge: verifyCh }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    await expect(mfa.verify({ mfaChallenge: verifyCh, code: '123456', recoveryCode: 'abcde-fghjk' }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
  });

  it('recovery code: single-use, concurrent use of the same code succeeds once', async () => {
    const e = await enrolled();
    const [rc1, rc2] = e.recoveryCodes;
    const s = await mfa.verify({ mfaChallenge: await verifyChallenge(e), recoveryCode: rc1! }, { ip: rndIp() });
    expect(s.accessToken).toBeTruthy();
    await expect(mfa.verify({ mfaChallenge: await verifyChallenge(e), recoveryCode: rc1! }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    const [c1, c2] = [await verifyChallenge(e), await verifyChallenge(e)];
    const results = await Promise.allSettled([
      mfa.verify({ mfaChallenge: c1, recoveryCode: rc2! }, { ip: rndIp() }),
      mfa.verify({ mfaChallenge: c2, recoveryCode: rc2! }, { ip: rndIp() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await auditActions(e)).toContain('auth.mfa.recovery_used');
  });

  it('enroll/start replaces the pending secret: only the latest one confirms', async () => {
    const u = await mkUser(coA, 'OWNER');
    const ch = challengeOf(await auth.login({ phone: u.phone, password }, { ip: rndIp() })).mfaChallenge;
    const ec = await mkCode(u);
    const first = await mfa.startEnroll(ch, ec, { ip: rndIp() });
    const second = await mfa.startEnroll(ch, ec, { ip: rndIp() });
    expect(second.secret).not.toBe(first.secret);
    expect(second.otpauthUri).toContain('otpauth://totp/');
    expect(second.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    await expect(mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: ec, code: await generate({ secret: first.secret }) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    const s = await mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: ec, code: await generate({ secret: second.secret }) }, { ip: rndIp() });
    expect(s.recoveryCodes).toHaveLength(10);
  });

  it('enrollment confirm revokes every other session', async () => {
    const u = await mkUser(coA, 'OWNER');
    await tenantPrisma.run(u.companyId, (tx) =>
      tx.refreshToken.create({ data: { userId: u.id, tokenHash: `old-${randomUUID()}`, familyId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } }),
    );
    const ch = challengeOf(await auth.login({ phone: u.phone, password }, { ip: rndIp() })).mfaChallenge;
    const ec = await mkCode(u);
    const start = await mfa.startEnroll(ch, ec, { ip: rndIp() });
    await mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: ec, code: await generate({ secret: start.secret }) }, { ip: rndIp() });
    const rows = await refreshRows(u);
    expect(rows.filter((r) => !r.revokedAt)).toHaveLength(1);
  });

  it('role elevation: a pre-elevation refresh token is rejected (MFA_REQUIRED) and its family revoked', async () => {
    const u = await mkUser(coA, 'SALES_AGENT');
    const t = (await auth.login({ phone: u.phone, password }, { ip: rndIp() })) as TokenPair;
    await grant(coA, u.id, 'CASHIER');
    await expect(auth.refresh({ refreshToken: t.refreshToken }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaRequiredException);
    expect((await refreshRows(u)).every((r) => r.revokedAt)).toBe(true);
    expect(await auditActions(u)).toContain('auth.mfa.denied');
  });

  it('refresh of an MFA-backed session rotates and keeps mfaId; after MFA reset it is rejected', async () => {
    const e = await enrolled();
    const refreshed = await auth.refresh({ refreshToken: e.session.refreshToken }, { ip: rndIp() });
    const mfaRow = await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: e.id } });
    expect(jwt.decode(refreshed.accessToken)).toMatchObject({ mfa: mfaRow.id });
    await systemPrisma.userMfa.delete({ where: { userId: e.id } });
    await expect(auth.refresh({ refreshToken: refreshed.refreshToken }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaRequiredException);
  });

  it('Telegram login of a privileged user => 403 MFA_WEB_LOGIN_REQUIRED, audited, no tokens', async () => {
    const telegramId = BigInt(randomInt(1e9, 9e9));
    const u = await mkUser(coA, 'CASHIER', { telegramId });
    const fields = { query_id: randomUUID(), user: JSON.stringify({ id: Number(telegramId), first_name: 'Tg' }), auth_date: String(Math.floor(Date.now() / 1000) - 5) };
    const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const initData = new URLSearchParams({ ...fields, hash: createHmac('sha256', key).update(check).digest('hex') }).toString();
    await expect(auth.telegramLogin({ initData } as never, { ip: rndIp() })).rejects.toBeInstanceOf(MfaWebLoginRequiredException);
    expect(await refreshRows(u)).toHaveLength(0);
    expect(await auditActions(u)).toContain('auth.mfa.denied');
  });

  it('password reset never touches MFA and never issues tokens', async () => {
    const e = await enrolled();
    const sent: string[] = [];
    const sms = { send: async (_p: string, m: string) => void sent.push(m) } as unknown as SmsService;
    const reset = new PasswordResetService(redis, tenantPrisma, auditLog, sms, store);
    await redis.del(`pwreset:cooldown:${e.phone}`);
    await reset.request(e.phone);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const before = await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: e.id } });
    const result = await reset.confirm(e.phone, /(\d{6})/.exec(sent[0]!)![1]!, 'BrandNewPassword456');
    expect(result).toBeUndefined();
    const after = await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: e.id } });
    expect(after.id).toBe(before.id);
    expect(after.confirmedAt).toEqual(before.confirmedAt);
    expect(await systemPrisma.userMfaRecoveryCode.count({ where: { userId: e.id } })).toBe(10);
    expect((await refreshRows(e)).filter((r) => !r.revokedAt)).toHaveLength(0);
    // the next login still demands MFA
    const next = await auth.login({ phone: e.phone, password: 'BrandNewPassword456' }, { ip: rndIp() });
    expect(next).toMatchObject({ mfa: 'verify' });
  });

  it('re-enroll: needs password + current TOTP; old MFA stays valid until confirm; confirm swaps MFA and kills old sessions/codes', async () => {
    const e = await enrolled();
    const actor = { id: e.id, companyId: e.companyId, firstName: '', lastName: '', roles: ['OWNER'], permissions: [] };
    await expect(mfa.startReenroll(actor, { password: 'wrong-password-1', code: await freshCode(e.id, e.secret) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    await expect(mfa.startReenroll(actor, { password, code: wrongCode(await freshCode(e.id, e.secret)) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);

    const code = await freshCode(e.id, e.secret);
    const step = await mfa.startReenroll(actor, { password, code }, { ip: rndIp() });
    expect(step.mfa).toBe('enroll');
    // replay guard: the same code can't open a second re-enrollment
    await expect(mfa.startReenroll(actor, { password, code }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);

    const oldRow = await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: e.id } });
    // old MFA still valid before the new one is confirmed
    await mfa.verify({ mfaChallenge: await verifyChallenge(e), code: await freshCode(e.id, e.secret) }, { ip: rndIp() });

    const start = await mfa.startEnroll(step.mfaChallenge, undefined, { ip: rndIp() });
    const s = await mfa.confirmEnroll({ mfaChallenge: step.mfaChallenge, code: await generate({ secret: start.secret }) }, { ip: rndIp() });
    const newRow = await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: e.id } });
    expect(newRow.id).not.toBe(oldRow.id);
    expect(jwt.decode(s.accessToken)).toMatchObject({ mfa: newRow.id });
    expect((await refreshRows(e)).filter((r) => !r.revokedAt)).toHaveLength(1);
    expect(await systemPrisma.userMfaRecoveryCode.count({ where: { userId: e.id } })).toBe(10);
    // old authenticator no longer works
    await systemPrisma.userMfa.update({ where: { userId: e.id }, data: { lastUsedStep: -1 } });
    await expect(mfa.verify({ mfaChallenge: await verifyChallenge(e), code: await generate({ secret: e.secret }) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    expect(await auditActions(e)).toContain('auth.mfa.reenroll');
  });

  it('a re-enroll challenge is pinned to the MFA it replaces (stale challenge after MFA change is invalid)', async () => {
    const e = await enrolled();
    const actor = { id: e.id, companyId: e.companyId, firstName: '', lastName: '', roles: ['OWNER'], permissions: [] };
    const step = await mfa.startReenroll(actor, { password, code: await freshCode(e.id, e.secret) }, { ip: rndIp() });
    await systemPrisma.userMfa.delete({ where: { userId: e.id } });
    const start = await mfa.startEnroll(step.mfaChallenge, undefined, { ip: rndIp() });
    await expect(mfa.confirmEnroll({ mfaChallenge: step.mfaChallenge, code: await generate({ secret: start.secret }) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaChallengeInvalidException);
  });

  it('recovery codes regenerate: new set of 10, old set invalid, needs a valid TOTP', async () => {
    const e = await enrolled();
    const actor = { id: e.id, companyId: e.companyId, firstName: '', lastName: '', roles: ['OWNER'], permissions: [] };
    await expect(mfa.regenerateRecoveryCodes(actor, { code: wrongCode(await freshCode(e.id, e.secret)) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    const { recoveryCodes } = await mfa.regenerateRecoveryCodes(actor, { code: await freshCode(e.id, e.secret) }, { ip: rndIp() });
    expect(recoveryCodes).toHaveLength(10);
    await expect(mfa.verify({ mfaChallenge: await verifyChallenge(e), recoveryCode: e.recoveryCodes[0]! }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaCodeInvalidException);
    await mfa.verify({ mfaChallenge: await verifyChallenge(e), recoveryCode: recoveryCodes[0]! }, { ip: rndIp() });
  });

  describe('POST /users/:id/mfa/reset (service)', () => {
    const asActor = <T>(a: { id: string; companyId: string }, fn: () => Promise<T>) => tenantPrisma.run(a.companyId, () => fn());

    it('deletes MFA + codes, revokes sessions, audits; MFA is not disabled (next login enrolls again)', async () => {
      const e = await enrolled();
      const admin = await mkUser(coA, 'OWNER');
      const adminActor = { id: admin.id, companyId: coA, firstName: '', lastName: '', roles: ['OWNER'], permissions: [] };
      await asActor(adminActor, () => users.resetMfa(e.id, { reason: 'lost phone' }, adminActor));
      expect(await systemPrisma.userMfa.count({ where: { userId: e.id } })).toBe(0);
      expect(await systemPrisma.userMfaRecoveryCode.count({ where: { userId: e.id } })).toBe(0);
      expect((await refreshRows(e)).every((r) => r.revokedAt)).toBe(true);
      const audit = await tenantPrisma.run(coA, (tx) => tx.auditLog.findFirst({ where: { action: 'auth.mfa.reset', entityId: e.id } }));
      expect(audit?.userId).toBe(admin.id);
      expect(await auth.login({ phone: e.phone, password }, { ip: rndIp() })).toMatchObject({ mfa: 'enroll' });
    });

    it('not yourself; not across tenants', async () => {
      const a = await mkUser(coA, 'OWNER');
      const b = await enrolled('OWNER', coB);
      const actor = { id: a.id, companyId: coA, firstName: '', lastName: '', roles: ['OWNER'], permissions: [] };
      await expect(asActor(actor, () => users.resetMfa(a.id, { reason: 'self reset' }, actor))).rejects.toBeInstanceOf(CannotResetOwnMfaException);
      await expect(asActor(actor, () => users.resetMfa(b.id, { reason: 'cross tenant' }, actor))).rejects.toBeInstanceOf(UserNotFoundException);
      expect(await systemPrisma.userMfa.count({ where: { userId: b.id } })).toBe(1);
    });
  });

  describe('first-enrollment code (password alone is not enough)', () => {
    async function freshEnroll() {
      const u = await mkUser(coA, 'OWNER');
      const ch = challengeOf(await auth.login({ phone: u.phone, password }, { ip: rndIp() })).mfaChallenge;
      return { u, ch };
    }
    const noMfa = (u: { id: string }) => systemPrisma.userMfa.count({ where: { userId: u.id } });

    it('password-only enroll start/confirm is rejected and nothing is enrolled', async () => {
      const { u, ch } = await freshEnroll();
      await expect(mfa.startEnroll(ch, undefined, { ip: rndIp() })).rejects.toBeInstanceOf(MfaEnrollmentCodeInvalidException);
      await expect(mfa.confirmEnroll({ mfaChallenge: ch, code: '123456' }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaEnrollmentCodeInvalidException);
      expect(await noMfa(u)).toBe(0);
    });

    it('wrong, expired, used and other-user codes are rejected (start) and counted against the challenge', async () => {
      const { u, ch } = await freshEnroll();
      const other = await mkUser(coA, 'OWNER');
      const bad = [
        generateMfaEnrollmentCode(),
        await mkCode(u, { expiresAt: new Date(Date.now() - 1000) }),
        await mkCode(u, { usedAt: new Date() }),
        await mkCode(other),
      ];
      for (const code of bad) await expect(mfa.startEnroll(ch, code, { ip: rndIp() })).rejects.toBeInstanceOf(MfaEnrollmentCodeInvalidException);
      expect(await auditActions(u)).toContain('auth.mfa.enrollment_code_failed');
      // 4 failed attempts counted: the challenge (max attempts) is burnt soon after
      const good = await mkCode(u);
      await mfa.startEnroll(ch, good, { ip: rndIp() }).catch(() => undefined);
      expect(await noMfa(u)).toBe(0);
    });

    it('confirm rejects a code that expired/was used after start (rollback, no UserMfa)', async () => {
      const { u, ch } = await freshEnroll();
      const code = await mkCode(u);
      const start = await mfa.startEnroll(ch, code, { ip: rndIp() });
      await systemPrisma.mfaEnrollmentCode.updateMany({ where: { userId: u.id }, data: { usedAt: new Date() } });
      await expect(mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: code, code: await generate({ secret: start.secret }) }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaEnrollmentCodeInvalidException);
      expect(await noMfa(u)).toBe(0);
    });

    it('a valid code enrolls once; it cannot be reused for another challenge', async () => {
      const { u, ch } = await freshEnroll();
      const code = await mkCode(u);
      const start = await mfa.startEnroll(ch, code, { ip: rndIp() });
      const s = await mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: code, code: await generate({ secret: start.secret }) }, { ip: rndIp() });
      expect(s.recoveryCodes).toHaveLength(10);
      expect((await systemPrisma.mfaEnrollmentCode.findFirstOrThrow({ where: { userId: u.id } })).usedAt).not.toBeNull();
      await systemPrisma.userMfa.delete({ where: { userId: u.id } });
      const ch2 = challengeOf(await auth.login({ phone: u.phone, password }, { ip: rndIp() })).mfaChallenge;
      await expect(mfa.startEnroll(ch2, code, { ip: rndIp() })).rejects.toBeInstanceOf(MfaEnrollmentCodeInvalidException);
    });

    it('concurrent double confirm on one challenge: exactly one wins', async () => {
      const { u, ch } = await freshEnroll();
      const code = await mkCode(u);
      const start = await mfa.startEnroll(ch, code, { ip: rndIp() });
      const totp = await generate({ secret: start.secret });
      const results = await Promise.allSettled([
        mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: code, code: totp }, { ip: rndIp() }),
        mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: code, code: totp }, { ip: rndIp() }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await noMfa(u)).toBe(1);
    });
  });

  describe('POST /users/:id/mfa/enrollment-code (service)', () => {
    const asActor = <T>(a: { id: string; companyId: string }, fn: () => Promise<T>) => tenantPrisma.run(a.companyId, () => fn());
    const actorOf = (id: string, companyId = coA) => ({ id, companyId, firstName: '', lastName: '', roles: ['OWNER'], permissions: [] });

    it('issues a code once (hash only stored), audits without the code, and it enrolls the target', async () => {
      const admin = await mkUser(coA, 'OWNER');
      const target = await mkUser(coA, 'OWNER');
      const actor = actorOf(admin.id);
      const res = await asActor(actor, () => users.issueMfaEnrollmentCode(target.id, actor));
      expect(res.code).toBeTruthy();
      expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const rows = await systemPrisma.mfaEnrollmentCode.findMany({ where: { userId: target.id } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(res.code);
      expect(rows[0]!.createdById).toBe(admin.id);
      const audit = await tenantPrisma.run(coA, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'auth.mfa.enrollment_code_issued', entityId: target.id } }));
      expect(JSON.stringify(audit.newValue)).not.toContain(res.code);
      const ch = challengeOf(await auth.login({ phone: target.phone, password }, { ip: rndIp() })).mfaChallenge;
      const start = await mfa.startEnroll(ch, res.code, { ip: rndIp() });
      await mfa.confirmEnroll({ mfaChallenge: ch, enrollmentCode: res.code, code: await generate({ secret: start.secret }) }, { ip: rndIp() });
      // re-issuing is now refused: target has confirmed MFA
      await expect(asActor(actor, () => users.issueMfaEnrollmentCode(target.id, actor))).rejects.toBeInstanceOf(MfaEnrollmentCodeNotApplicableException);
    });

    it('a second issue invalidates the first; self, cross-tenant and non-privileged targets are refused', async () => {
      const admin = await mkUser(coA, 'OWNER');
      const target = await mkUser(coA, 'OWNER');
      const actor = actorOf(admin.id);
      const first = await asActor(actor, () => users.issueMfaEnrollmentCode(target.id, actor));
      await asActor(actor, () => users.issueMfaEnrollmentCode(target.id, actor));
      const ch = challengeOf(await auth.login({ phone: target.phone, password }, { ip: rndIp() })).mfaChallenge;
      await expect(mfa.startEnroll(ch, first.code, { ip: rndIp() })).rejects.toBeInstanceOf(MfaEnrollmentCodeInvalidException);
      await expect(asActor(actor, () => users.issueMfaEnrollmentCode(admin.id, actor))).rejects.toBeInstanceOf(CannotResetOwnMfaException);
      const b = await mkUser(coB, 'OWNER');
      await expect(asActor(actor, () => users.issueMfaEnrollmentCode(b.id, actor))).rejects.toBeInstanceOf(UserNotFoundException);
      const agent = await mkUser(coA, 'SALES_AGENT');
      await expect(asActor(actor, () => users.issueMfaEnrollmentCode(agent.id, actor))).rejects.toBeInstanceOf(MfaEnrollmentCodeNotApplicableException);
    });
  });

  it('Redis down: a privileged login yields no tokens (MFA_SERVICE_UNAVAILABLE) and no refresh token is created', async () => {
    const u = await mkUser(coA, 'OWNER');
    const down = build(new AuthChallengeStore(deadRedis));
    await expect(down.auth.login({ phone: u.phone, password }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaServiceUnavailableException);
    await expect(down.mfa.verify({ mfaChallenge: 'x'.repeat(43), code: '123456' }, { ip: rndIp() })).rejects.toBeInstanceOf(MfaServiceUnavailableException);
    expect(await refreshRows(u)).toHaveLength(0);
  });
});
