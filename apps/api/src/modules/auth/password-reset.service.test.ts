import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import Redis from 'ioredis';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import {
  AuthChallengeInvalidException,
  PasswordResetCodeExpiredException,
  PasswordResetCodeInvalidException,
} from '../../common/auth/auth-exceptions';
import type { SmsService } from '../../common/sms/sms.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AuthChallengeStore } from './auth-challenge.store';
import { PasswordResetService, type AccountSelectionRequired } from './password-reset.service';

const oldPassword = 'OldPasswordValue123'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const newPassword = 'BrandNewPassword456'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const rndIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const uniquePhone = () => `+998${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe('ADR-057a password reset (real Postgres + Redis)', () => {
  const tenantPrisma = new TenantPrismaService();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sent: { phone: string; message: string }[] = [];
  const sms = { send: async (phone: string, message: string) => void sent.push({ phone, message }) } as unknown as SmsService;
  const svc = new PasswordResetService(redis, tenantPrisma, new AuditLogService(), sms, new AuthChallengeStore(redis));
  let coA: string;
  let coB: string;
  let hash: string;

  async function company(name: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `t-pr-${name}-${Date.now()}-${randomInt(1e6)}`, name } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name } })).id;
  }
  const mkUser = (companyId: string, phone: string) =>
    systemPrisma.user.create({ data: { companyId, firstName: 'P', lastName: 'R', phone, passwordHash: hash } });
  async function session(user: { id: string; companyId: string }) {
    return tenantPrisma.run(user.companyId, (tx) =>
      tx.refreshToken.create({
        data: { userId: user.id, tokenHash: `h-${user.id}-${randomInt(1e9)}`, familyId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
      }),
    );
  }
  const revoked = async (u: { id: string; companyId: string }) =>
    (await tenantPrisma.run(u.companyId, (tx) => tx.refreshToken.findMany({ where: { userId: u.id } }))).map((t) => t.revokedAt !== null);
  async function otpFor(phone: string): Promise<string> {
    await redis.del(`pwreset:cooldown:${phone}`);
    const before = sent.filter((s) => s.phone === phone).length;
    await svc.request(phone);
    await vi.waitFor(() => expect(sent.filter((s) => s.phone === phone).length).toBe(before + 1));
    const msg = sent.filter((s) => s.phone === phone).at(-1)!.message;
    return /(\d{6})/.exec(msg)![1];
  }
  async function pwOk(userId: string, pw: string) {
    const u = await systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    return argon2.verify(u.passwordHash!, pw);
  }

  beforeAll(async () => {
    hash = await argon2.hash(oldPassword, { type: argon2.argon2id });
    coA = await company('PrA');
    coB = await company('PrB');
  });
  afterAll(async () => {
    redis.disconnect();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('single account: OTP confirm changes the password and revokes its sessions (204 path)', async () => {
    const phone = uniquePhone();
    const u = await mkUser(coA, phone);
    await session(u);
    const code = await otpFor(phone);
    expect(await svc.confirm(phone, code, newPassword)).toBeUndefined();
    expect(await pwOk(u.id, newPassword)).toBe(true);
    expect(await revoked(u)).toEqual([true]);
  });

  it('OTP replay is rejected; wrong code counts attempts and locks after 5', async () => {
    const phone = uniquePhone();
    await mkUser(coA, phone);
    const code = await otpFor(phone);
    await svc.confirm(phone, code, newPassword);
    await expect(svc.confirm(phone, code, newPassword)).rejects.toBeInstanceOf(PasswordResetCodeExpiredException);

    const p2 = uniquePhone();
    await mkUser(coA, p2);
    const c2 = await otpFor(p2);
    const wrong = c2 === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await expect(svc.confirm(p2, wrong, newPassword)).rejects.toBeInstanceOf(PasswordResetCodeInvalidException);
    await expect(svc.confirm(p2, c2, newPassword)).rejects.toBeInstanceOf(PasswordResetCodeExpiredException);
  });

  it('parallel wrong guesses cannot exceed the attempt limit (atomic counter)', async () => {
    const phone = uniquePhone();
    await mkUser(coA, phone);
    const code = await otpFor(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => svc.confirm(phone, wrong, newPassword)));
    const invalid = results.filter((r) => r.status === 'rejected' && r.reason instanceof PasswordResetCodeInvalidException);
    expect(invalid.length).toBe(5);
    await expect(svc.confirm(phone, code, newPassword)).rejects.toBeInstanceOf(PasswordResetCodeExpiredException);
  });

  it('request() does not await the SMS gateway for a known phone', async () => {
    const phone = uniquePhone();
    await mkUser(coA, phone);
    await redis.del(`pwreset:cooldown:${phone}`);
    const slowSvc = new PasswordResetService(
      redis,
      tenantPrisma,
      new AuditLogService(),
      { send: () => new Promise((r) => setTimeout(r, 1500)) } as unknown as SmsService,
      new AuthChallengeStore(redis),
    );
    const t0 = Date.now();
    await slowSvc.request(phone);
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  it('expired OTP is rejected', async () => {
    const phone = uniquePhone();
    await mkUser(coA, phone);
    const code = await otpFor(phone);
    await redis.del(`pwreset:code:${phone}`);
    await expect(svc.confirm(phone, code, newPassword)).rejects.toBeInstanceOf(PasswordResetCodeExpiredException);
  });

  it('unknown and known phones behave identically on a wrong code (no enumeration)', async () => {
    const known = uniquePhone();
    const unknown = uniquePhone();
    await mkUser(coA, known);
    await otpFor(known);
    await redis.del(`pwreset:cooldown:${unknown}`);
    await svc.request(unknown);
    expect(sent.some((s) => s.phone === unknown)).toBe(false);
    for (const p of [known, unknown]) {
      await expect(svc.confirm(p, '000000', newPassword)).rejects.toMatchObject({ response: { code: 'AUTH_RESET_CODE_INVALID' } });
    }
  });

  it('several accounts: nothing is revealed or changed before proof; after OTP only the handle flow changes the chosen account', async () => {
    const ipA = rndIp();
    const phone = uniquePhone();
    const uA = await mkUser(coA, phone);
    const uB = await mkUser(coB, phone);
    const other = await mkUser(coB, uniquePhone()); // unrelated tenant account
    await session(uA);
    await session(uB);
    await session(other);

    // before proof: wrong code reveals no accounts
    await otpFor(phone);
    await expect(svc.confirm(phone, '000000', newPassword)).rejects.toBeInstanceOf(PasswordResetCodeInvalidException);

    const code = await otpFor(phone);
    const r = (await svc.confirm(phone, code, newPassword)) as AccountSelectionRequired;
    expect(r.requiresAccountSelection).toBe(true);
    expect(r.accounts.map((a) => a.name).sort()).toEqual(['PrA', 'PrB']);
    expect(JSON.stringify(r)).not.toContain(coA);
    // confirm alone changed nothing
    expect(await pwOk(uA.id, oldPassword)).toBe(true);
    expect(await pwOk(uB.id, oldPassword)).toBe(true);
    expect(await revoked(uA)).toEqual([false]);

    const optA = r.accounts.find((a) => a.name === 'PrA')!;
    await svc.selectAccount({ resetHandle: r.resetHandle, optionId: optA.id, newPassword }, ipA);
    expect(await pwOk(uA.id, newPassword)).toBe(true);
    expect(await revoked(uA)).toEqual([true]);
    // other account of same phone and other tenant's user untouched
    expect(await pwOk(uB.id, oldPassword)).toBe(true);
    expect(await revoked(uB)).toEqual([false]);
    expect(await pwOk(other.id, oldPassword)).toBe(true);
    expect(await revoked(other)).toEqual([false]);
    // no session/refresh token created by the reset
    expect((await tenantPrisma.run(coA, (tx) => tx.refreshToken.count({ where: { userId: uA.id } })))).toBe(1);

    // handle is single-use
    await expect(
      svc.selectAccount({ resetHandle: r.resetHandle, optionId: optA.id, newPassword }, ipA),
    ).rejects.toBeInstanceOf(AuthChallengeInvalidException);

    // audit lands in the chosen tenant only
    const auditA = await tenantPrisma.run(coA, (tx) => tx.auditLog.findMany({ where: { entityId: uA.id, action: 'auth.password_reset_completed' } }));
    const auditB = await tenantPrisma.run(coB, (tx) => tx.auditLog.findMany({ where: { entityId: uB.id, action: 'auth.password_reset_completed' } }));
    expect(auditA).toHaveLength(1);
    expect(auditB).toHaveLength(0);
  });

  it('forged/foreign handle or option is rejected and changes nothing', async () => {
    const ipB = rndIp();
    const p1 = uniquePhone();
    const p2 = uniquePhone();
    const a1 = await mkUser(coA, p1);
    await mkUser(coB, p1);
    await mkUser(coA, p2);
    await mkUser(coB, p2);
    const r1 = (await svc.confirm(p1, await otpFor(p1), newPassword)) as AccountSelectionRequired;
    const r2 = (await svc.confirm(p2, await otpFor(p2), newPassword)) as AccountSelectionRequired;
    await expect(
      svc.selectAccount({ resetHandle: r1.resetHandle, optionId: r2.accounts[0].id, newPassword }, ipB),
    ).rejects.toBeInstanceOf(AuthChallengeInvalidException);
    await expect(
      svc.selectAccount({ resetHandle: r1.resetHandle, optionId: r1.accounts[0].id, newPassword }, ipB),
    ).rejects.toBeInstanceOf(AuthChallengeInvalidException); // burned
    await expect(
      svc.selectAccount({ resetHandle: 'z'.repeat(43), optionId: 'y'.repeat(22), newPassword }, ipB),
    ).rejects.toBeInstanceOf(AuthChallengeInvalidException);
    expect(await pwOk(a1.id, oldPassword)).toBe(true);
  });
});
