import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { CreateUserDto } from './dto/create-user.dto';
import {
  CannotDeactivateSelfException,
  CannotDeleteOwnerException,
  CannotDeleteSelfException,
  CannotGrantOwnerRoleException,
  DuplicateUserPhoneException,
  InvalidRoleCodesException,
  LastOwnerException,
  UserAlreadyActiveException,
  UserAlreadyInactiveException,
  UserHasReferencesException,
} from './users-exceptions';
import { AuthChallengeStore } from '../auth/auth-challenge.store';
import { MfaService } from '../auth/mfa.service';
import { AuthService, type MfaStepRequired } from '../auth/auth.service';
import { LoginRateLimiterService } from '../auth/login-rate-limiter.service';
import { SecretBox } from '../../common/crypto/secret-box';
import { MfaChallengeInvalidException, MfaCodeInvalidException } from '../../common/auth/auth-exceptions';
import { CannotResetOwnMfaException, CannotResetOwnerMfaException, UserNotFoundException } from './users-exceptions';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import Redis from 'ioredis';
import { generate } from 'otplib';
import { generateMfaEnrollmentCode, hashMfaEnrollmentCode } from '@velto/database';
import { randomInt } from 'node:crypto';
import { UsersService } from './users.service';

// Prod keeps Prisma's 5s tx default; remove() runs ~20 reference-count queries which under full-suite
// DB contention measured >6s (P2028). The tests assert behaviour, not latency, so give the tx room.
const LOAD_TX = { timeout: 30_000 };

describe('UsersService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let actor: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const users = new UsersService(tenantPrisma, auditLog, {} as unknown as MfaService, {} as unknown as AuthChallengeStore) // MFA step-up is not exercised here;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-users-${Date.now()}`, name: 'Users Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Users Test Co' } });
    companyId = company.id;

    await tenantPrisma.run(companyId, (tx) =>
      tx.role.createMany({
        data: [
          { companyId, code: 'OWNER', name: 'Egasi', isSystem: true },
          { companyId, code: 'SALES_AGENT', name: 'Savdo agenti', isSystem: true },
        ],
      }),
    );

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Admin', lastName: 'User', phone: '+998900000090' },
    });
    actor = { id: dbUser.id, companyId, firstName: 'Admin', lastName: 'User', roles: ['OWNER'], permissions: ['users.create', 'users.update'] };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  let seq = 1;
  const dto = (overrides: Partial<CreateUserDto> = {}): CreateUserDto => {
    const n = seq++;
    return {
      firstName: 'Anvar',
      lastName: `Tursunov${n}`,
      phone: `+99890111${String(1000 + n).slice(1)}`,
      roleCodes: ['SALES_AGENT'],
      ...overrides,
    };
  };

  it('creates a user with roles and never returns a passwordHash field', async () => {
    const created = await tenantPrisma.run(companyId, () => users.create(dto({ password: 'a-decent-passphrase' }), actor));
    expect(created.roles.map((r) => r.code)).toEqual(['SALES_AGENT']);
    expect('passwordHash' in created).toBe(false);
  });

  it('list() returns mfaEnabled true only for a confirmed UserMfa, and no MFA secret material', async () => {
    const withMfa = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
    const pending = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
    const without = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
    const row = { secretCiphertext: Buffer.from('c'), secretIv: Buffer.from('i'), secretTag: Buffer.from('t'), keyVersion: 1 };
    await systemPrisma.userMfa.create({ data: { companyId, userId: withMfa.id, ...row, confirmedAt: new Date() } });
    await systemPrisma.userMfa.create({ data: { companyId, userId: pending.id, ...row, confirmedAt: null } });
    const res = await tenantPrisma.run(companyId, () => users.list({ page: 1, pageSize: 100 } as never));
    const by = (id: string) => res.data.find((u) => u.id === id)!;
    expect(by(withMfa.id).mfaEnabled).toBe(true);
    expect(by(pending.id).mfaEnabled).toBe(false);
    expect(by(without.id).mfaEnabled).toBe(false);
    expect(JSON.stringify(res.data)).not.toContain('secretCiphertext');
    expect('mfa' in by(withMfa.id)).toBe(false);
  });

  it('rejects a duplicate phone within the same tenant', async () => {
    const phone = '+998901110099';
    await tenantPrisma.run(companyId, () => users.create(dto({ phone }), actor));
    await expect(tenantPrisma.run(companyId, () => users.create(dto({ phone }), actor))).rejects.toBeInstanceOf(
      DuplicateUserPhoneException,
    );
  });

  it('rejects an unknown role code', async () => {
    await expect(
      tenantPrisma.run(companyId, () => users.create(dto({ roleCodes: ['NOT_A_ROLE'] }), actor)),
    ).rejects.toBeInstanceOf(InvalidRoleCodesException);
  });

  it('update() replaces the role set entirely', async () => {
    const created = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
    const updated = await tenantPrisma.run(companyId, () => users.update(created.id, { roleCodes: ['OWNER'] }, actor));
    expect(updated.roles.map((r) => r.code)).toEqual(['OWNER']);
  });

  it('deactivate() revokes active sessions and is not idempotent; activate() reverses it', async () => {
    const created = await tenantPrisma.run(companyId, () => users.create(dto(), actor));

    await tenantPrisma.run(companyId, (tx) =>
      tx.refreshToken.create({
        data: { userId: created.id, tokenHash: 'x', familyId: created.id, expiresAt: new Date(Date.now() + 60_000) },
      }),
    );

    const deactivated = await tenantPrisma.run(companyId, () => users.deactivate(created.id, actor));
    expect(deactivated.isActive).toBe(false);

    const tokens = await tenantPrisma.run(companyId, (tx) => tx.refreshToken.findMany({ where: { userId: created.id } }));
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    await expect(tenantPrisma.run(companyId, () => users.deactivate(created.id, actor))).rejects.toBeInstanceOf(
      UserAlreadyInactiveException,
    );

    const activated = await tenantPrisma.run(companyId, () => users.activate(created.id, actor));
    expect(activated.isActive).toBe(true);

    await expect(tenantPrisma.run(companyId, () => users.activate(created.id, actor))).rejects.toBeInstanceOf(
      UserAlreadyActiveException,
    );
  });

  it('refuses to let a user deactivate their own account', async () => {
    await expect(tenantPrisma.run(companyId, () => users.deactivate(actor.id, actor))).rejects.toBeInstanceOf(
      CannotDeactivateSelfException,
    );
  });

  it('refuses to let a non-owner grant the OWNER role, via create() or update()', async () => {
    const nonOwnerActor: AuthenticatedUser = { ...actor, roles: ['SALES_DIRECTOR'], permissions: ['users.create', 'users.update'] };

    await expect(
      tenantPrisma.run(companyId, () => users.create(dto({ roleCodes: ['OWNER'] }), nonOwnerActor)),
    ).rejects.toBeInstanceOf(CannotGrantOwnerRoleException);

    const target = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
    await expect(
      tenantPrisma.run(companyId, () => users.update(target.id, { roleCodes: ['OWNER'] }, nonOwnerActor)),
    ).rejects.toBeInstanceOf(CannotGrantOwnerRoleException);
  });

  // These two tests need to know the *exact* count of real, DB-backed OWNER
  // holders in the company — the shared `companyId` above already
  // accumulates OWNER-role users from earlier tests (e.g. "update() replaces
  // the role set entirely"), so they get their own fresh company instead.
  async function createIsolatedCompany() {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-users-owner-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: 'Owner Isolation Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Owner Isolation Co' } });
    await tenantPrisma.run(company.id, (tx) =>
      tx.role.createMany({
        data: [
          { companyId: company.id, code: 'OWNER', name: 'Egasi', isSystem: true },
          { companyId: company.id, code: 'SALES_AGENT', name: 'Savdo agenti', isSystem: true },
        ],
      }),
    );
    const freshActor: AuthenticatedUser = { ...actor, companyId: company.id };
    return { companyId: company.id, freshActor };
  }

  it("refuses to deactivate or demote the tenant's sole real OWNER", async () => {
    const { companyId: isolatedCompanyId, freshActor } = await createIsolatedCompany();
    const soleOwner = await tenantPrisma.run(isolatedCompanyId, () => users.create(dto({ roleCodes: ['OWNER'] }), freshActor));

    await expect(
      tenantPrisma.run(isolatedCompanyId, () => users.deactivate(soleOwner.id, freshActor)),
    ).rejects.toBeInstanceOf(LastOwnerException);
    await expect(
      tenantPrisma.run(isolatedCompanyId, () => users.update(soleOwner.id, { roleCodes: ['SALES_AGENT'] }, freshActor)),
    ).rejects.toBeInstanceOf(LastOwnerException);
  });

  it('allows demoting/deactivating an OWNER as long as another active OWNER remains afterward', async () => {
    // Each action is checked against its own pair (not chained on the same
    // two users) — demoting ownerA1 correctly leaves ownerB1 as the new
    // sole owner, so a *second* removal on that same pair should (and does,
    // per the test above) start failing again.
    const { companyId: company1, freshActor: actor1 } = await createIsolatedCompany();
    const ownerA1 = await tenantPrisma.run(company1, () => users.create(dto({ roleCodes: ['OWNER'] }), actor1));
    await tenantPrisma.run(company1, () => users.create(dto({ roleCodes: ['OWNER'] }), actor1)); // keeps a 2nd owner in place
    const demoted = await tenantPrisma.run(company1, () => users.update(ownerA1.id, { roleCodes: ['SALES_AGENT'] }, actor1));
    expect(demoted.roles.map((r) => r.code)).toEqual(['SALES_AGENT']);

    const { companyId: company2, freshActor: actor2 } = await createIsolatedCompany();
    await tenantPrisma.run(company2, () => users.create(dto({ roleCodes: ['OWNER'] }), actor2)); // keeps a 2nd owner in place
    const ownerB2 = await tenantPrisma.run(company2, () => users.create(dto({ roleCodes: ['OWNER'] }), actor2));
    const deactivated = await tenantPrisma.run(company2, () => users.deactivate(ownerB2.id, actor2));
    expect(deactivated.isActive).toBe(false);
  });

  describe('remove()', () => {
    /** Cheapest real FK into User that doesn't require standing up a whole order/route graph. */
    const addReference = (targetCompanyId: string, userId: string) =>
      tenantPrisma.run(targetCompanyId, (tx) =>
        tx.notification.create({
          data: {
            companyId: targetCompanyId,
            recipientId: userId,
            type: 'order.on_hold',
            title: { uz: 't', ru: 't', en: 't' },
            message: { uz: 'm', ru: 'm', en: 'm' },
          },
        }),
      );

    it('hard-deletes a user that owns no business records', async () => {
      const created = await tenantPrisma.run(companyId, () => users.create(dto(), actor));

      const result = await tenantPrisma.run(companyId, () => users.remove(created.id, {}, actor), LOAD_TX);
      expect(result.mode).toBe('hard');

      const [row, roleLinks] = await tenantPrisma.run(companyId, async (tx) => [
        await tx.user.findUnique({ where: { id: created.id } }),
        await tx.userRole.count({ where: { userId: created.id } }),
      ]);
      expect(row).toBeNull();
      expect(roleLinks).toBe(0);
    });

    it('soft-deletes (anonymizes) a user that owns records, freeing their phone and killing their sessions', async () => {
      const phone = '+998901119901';
      const created = await tenantPrisma.run(companyId, () => users.create(dto({ phone }), actor));
      await addReference(companyId, created.id);
      await tenantPrisma.run(companyId, (tx) =>
        tx.refreshToken.create({
          data: { userId: created.id, tokenHash: 'y', familyId: created.id, expiresAt: new Date(Date.now() + 60_000) },
        }),
      );

      const result = await tenantPrisma.run(companyId, () => users.remove(created.id, {}, actor), LOAD_TX);
      expect(result.mode).toBe('soft');
      expect(result.references.notifications).toBe(1);
      expect(result.user?.isActive).toBe(false);
      expect(result.user?.roles).toEqual([]);
      expect(result.user?.phone).toBe(`deleted:${created.id}`);

      const [row, tokens] = await tenantPrisma.run(companyId, async (tx) => [
        await tx.user.findUnique({ where: { id: created.id } }),
        await tx.refreshToken.findMany({ where: { userId: created.id } }),
      ]);
      expect(row).not.toBeNull();
      expect(row?.passwordHash).toBeNull();
      expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

      // The tombstoned phone is free again under @@unique([companyId, phone]).
      const reused = await tenantPrisma.run(companyId, () => users.create(dto({ phone }), actor));
      expect(reused.phone).toBe(phone);
    });

    it('refuses ?hard=true when the user still owns records, instead of silently soft-deleting', async () => {
      const created = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
      await addReference(companyId, created.id);

      await expect(
        tenantPrisma.run(companyId, () => users.remove(created.id, { hard: true }, actor), LOAD_TX),
      ).rejects.toBeInstanceOf(UserHasReferencesException);

      const row = await tenantPrisma.run(companyId, (tx) => tx.user.findUnique({ where: { id: created.id } }));
      expect(row).not.toBeNull();
    });

    it('writes an audit entry that outlives the hard-deleted row', async () => {
      const created = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
      await tenantPrisma.run(companyId, () => users.remove(created.id, {}, actor), LOAD_TX);

      const entries = await tenantPrisma.run(companyId, (tx) =>
        tx.auditLog.findMany({ where: { entity: 'User', entityId: created.id, action: 'user.delete' } }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe(actor.id);
    });

    it('refuses to let a user delete their own account', async () => {
      await expect(tenantPrisma.run(companyId, () => users.remove(actor.id, {}, actor), LOAD_TX)).rejects.toBeInstanceOf(
        CannotDeleteSelfException,
      );
    });

    it("refuses to delete the tenant's sole remaining OWNER", async () => {
      const { companyId: isolatedCompanyId, freshActor } = await createIsolatedCompany();
      const soleOwner = await tenantPrisma.run(isolatedCompanyId, () =>
        users.create(dto({ roleCodes: ['OWNER'] }), freshActor),
      );

      await expect(
        tenantPrisma.run(isolatedCompanyId, () => users.remove(soleOwner.id, {}, freshActor), LOAD_TX),
      ).rejects.toBeInstanceOf(LastOwnerException);
    });

    it('refuses to let a non-owner delete an OWNER (SEC-020..024)', async () => {
      const { companyId: isolatedCompanyId, freshActor } = await createIsolatedCompany();
      await tenantPrisma.run(isolatedCompanyId, () => users.create(dto({ roleCodes: ['OWNER'] }), freshActor));
      const otherOwner = await tenantPrisma.run(isolatedCompanyId, () =>
        users.create(dto({ roleCodes: ['OWNER'] }), freshActor),
      );
      const director: AuthenticatedUser = { ...freshActor, roles: ['SALES_DIRECTOR'], permissions: ['users.delete'] };

      await expect(
        tenantPrisma.run(isolatedCompanyId, () => users.remove(otherOwner.id, {}, director), LOAD_TX),
      ).rejects.toBeInstanceOf(CannotDeleteOwnerException);
    });
  });

  // ADR-058 step-up admin MFA reset (service level, real Postgres + Redis). Complements auth/mfa.service.test.ts.
  describe('resetMfa() step-up (ADR-058)', () => {
    const pw = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
    const cfg = { get: (k: string, d?: unknown) => (k === 'MFA_ENCRYPTION_KEY' ? process.env.MFA_ENCRYPTION_KEY : d), getOrThrow: (k: string) => (k === 'MFA_ENCRYPTION_KEY' ? process.env.MFA_ENCRYPTION_KEY : undefined) } as unknown as ConfigService;
    const limiter = new LoginRateLimiterService(redis);
    const store = new AuthChallengeStore(redis);
    const auth = new AuthService(jwt, cfg, tenantPrisma, limiter, auditLog, store);
    const mfaSvc = new MfaService(auth, tenantPrisma, store, limiter, auditLog, new SecretBox(cfg));
    const svc = new UsersService(tenantPrisma, auditLog, mfaSvc, store);
    const ip = () => ({ ip: `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}` });
    let hash: string;
    let coA: string;
    let coB: string;
    let coNoPerm: string;

    afterAll(() => {
      redis.disconnect();
    });

    async function mkCompany(name: string) {
      const tenant = await systemPrisma.tenant.create({ data: { slug: `t-su-${name}-${Date.now()}-${randomInt(1e6)}`, name } });
      return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name } })).id;
    }
    async function grantRole(companyId: string, userId: string, code: string) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = (await tx.role.findFirst({ where: { companyId, code } })) ?? (await tx.role.create({ data: { companyId, code, name: code, isSystem: true } }));
        await tx.userRole.create({ data: { userId, roleId: role.id } });
      });
    }
    async function grantResetPerm(companyId: string) {
      const perm = await systemPrisma.permission.upsert({ where: { module_code: { module: 'users', code: 'mfa_reset' } }, update: {}, create: { module: 'users', code: 'mfa_reset' } });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.findFirstOrThrow({ where: { companyId, code: 'OWNER' } });
        if (!(await tx.rolePermission.findFirst({ where: { roleId: role.id, permissionId: perm.id } }))) await tx.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      });
    }
    /** MFA-enrolled user of the given role, logged in through the real first-enrollment flow. */
    async function enrolled(companyId: string, roleCode: string) {
      const user = await systemPrisma.user.create({ data: { companyId, firstName: roleCode, lastName: 'Su', phone: `+998${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`, passwordHash: hash } });
      await grantRole(companyId, user.id, roleCode);
      const step = (await auth.login({ phone: user.phone, password: pw }, ip())) as MfaStepRequired;
      const code = generateMfaEnrollmentCode();
      await systemPrisma.mfaEnrollmentCode.create({ data: { companyId, userId: user.id, codeHash: hashMfaEnrollmentCode(code), expiresAt: new Date(Date.now() + 3_600_000) } });
      const start = await mfaSvc.startEnroll(step.mfaChallenge, code, ip());
      const session = await mfaSvc.confirmEnroll({ mfaChallenge: step.mfaChallenge, enrollmentCode: code, code: await generate({ secret: start.secret }) }, ip());
      const sid = (jwt.decode(session.accessToken) as { sid: string }).sid;
      return { id: user.id, companyId, secret: start.secret, sid };
    }
    type E = Awaited<ReturnType<typeof enrolled>>;
    const asActor = (e: E): AuthenticatedUser => ({ id: e.id, companyId: e.companyId, firstName: '', lastName: '', roles: ['OWNER'], permissions: ['users.mfa_reset'], sid: e.sid });
    const fresh = async (e: E) => {
      await systemPrisma.userMfa.update({ where: { userId: e.id }, data: { lastUsedStep: -1 } });
      return generate({ secret: e.secret });
    };
    const doReset = async (e: E, targetId: string, challengeId: string, over: Partial<{ currentPassword: string; totpCode: string }> = {}, service = svc, actorOverride?: AuthenticatedUser) =>
      service.resetMfa(targetId, { challengeId, reason: 'lost phone', currentPassword: pw, totpCode: over.totpCode ?? (await fresh(e)), ...over }, actorOverride ?? asActor(e), ip());
    const live = (id: string) => systemPrisma.refreshToken.count({ where: { userId: id, revokedAt: null } });
    const expectIntact = async (t: E) => {
      expect(await systemPrisma.userMfa.count({ where: { userId: t.id } })).toBe(1);
      expect(await systemPrisma.userMfaRecoveryCode.count({ where: { userId: t.id } })).toBe(10);
      expect(await live(t.id)).toBeGreaterThan(0);
    };

    beforeAll(async () => {
      hash = await argon2.hash(pw, { type: argon2.argon2id });
      [coA, coB, coNoPerm] = await Promise.all([mkCompany('A'), mkCompany('B'), mkCompany('N')]);
      await grantRole(coA, (await systemPrisma.user.create({ data: { companyId: coA, firstName: 'x', lastName: 'x', phone: `+998${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}` } })).id, 'OWNER');
      await grantResetPerm(coA);
    });

    it('ADR-058: successful step-up deletes MFA + recovery codes, revokes sessions, returns enrollment code once, writes audit', async () => {
      const a = await enrolled(coA, 'OWNER');
      const t = await enrolled(coA, 'CASHIER');
      const { challengeId } = await svc.createMfaResetChallenge(t.id, asActor(a));
      const res = await doReset(a, t.id, challengeId);
      expect(res).toMatchObject({ reset: true, sessionsRevoked: 1, enrollmentCode: { code: expect.any(String) } });
      expect(await systemPrisma.userMfa.count({ where: { userId: t.id } })).toBe(0);
      expect(await systemPrisma.userMfaRecoveryCode.count({ where: { userId: t.id } })).toBe(0);
      expect(await live(t.id)).toBe(0);
      const audit = await tenantPrisma.run(coA, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'auth.mfa.reset', entityId: t.id } }));
      expect(audit.userId).toBe(a.id);
      expect(JSON.stringify(audit.newValue)).not.toContain(res.enrollmentCode!.code);
      expect(await systemPrisma.mfaEnrollmentCode.count({ where: { userId: t.id, usedAt: null } })).toBe(1);
    });

    it('ADR-058: actor without users.mfa_reset is rejected in the final tx, target untouched', async () => {
      const a = await enrolled(coNoPerm, 'OWNER'); // OWNER role in this company has no mfa_reset permission row
      const t = await enrolled(coNoPerm, 'CASHIER');
      const { challengeId } = await svc.createMfaResetChallenge(t.id, asActor(a));
      await expect(doReset(a, t.id, challengeId)).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      await expectIntact(t);
    });

    it('ADR-058: wrong password and replayed TOTP are rejected, target untouched', async () => {
      const a = await enrolled(coA, 'OWNER');
      const t = await enrolled(coA, 'CASHIER');
      const { challengeId } = await svc.createMfaResetChallenge(t.id, asActor(a));
      await expect(doReset(a, t.id, challengeId, { currentPassword: 'wrong-password' })).rejects.toBeInstanceOf(MfaCodeInvalidException);
      const code = await fresh(a);
      await mfaSvc.reverifyActor(asActor(a), { password: pw, totpCode: code }, ip(), 'auth.mfa.reset_reauth'); // burns the step
      await expect(doReset(a, t.id, challengeId, { totpCode: code }).catch((e) => e)).resolves.toBeInstanceOf(MfaCodeInvalidException); // replay
      await expectIntact(t);
    });

    it('ADR-058: challenge bound to another target / another actor; cross-tenant target is not found', async () => {
      const a = await enrolled(coA, 'OWNER');
      const t = await enrolled(coA, 'CASHIER');
      const other = await enrolled(coA, 'CASHIER');
      const foreign = await enrolled(coB, 'CASHIER');
      const forOther = (await svc.createMfaResetChallenge(other.id, asActor(a))).challengeId;
      await expect(doReset(a, t.id, forOther)).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      const mine = (await svc.createMfaResetChallenge(t.id, asActor(a))).challengeId;
      const a2 = await enrolled(coA, 'OWNER');
      await expect(doReset(a2, t.id, mine)).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      await expect(svc.createMfaResetChallenge(foreign.id, asActor(a))).rejects.toBeInstanceOf(UserNotFoundException);
      const crossCo = (await svc.createMfaResetChallenge(t.id, asActor(a))).challengeId;
      await expect(doReset(a, t.id, crossCo, {}, svc, { ...asActor(a), companyId: coB })).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      await expectIntact(t);
      await expectIntact(other);
      await expectIntact(foreign);
    });

    it('ADR-058: self-reset and OWNER target are rejected', async () => {
      const a = await enrolled(coA, 'OWNER');
      const owner2 = await enrolled(coA, 'OWNER');
      await expect(svc.createMfaResetChallenge(a.id, asActor(a))).rejects.toBeInstanceOf(CannotResetOwnMfaException);
      await expect(svc.createMfaResetChallenge(owner2.id, asActor(a))).rejects.toBeInstanceOf(CannotResetOwnerMfaException);
      await expect(doReset(a, a.id, 'x'.repeat(43))).rejects.toBeInstanceOf(CannotResetOwnMfaException);
      await expectIntact(owner2);
    });

    it('ADR-058: pre-proof rejections (self / OWNER / not found / bad challenge) write exactly one precheck audit row, no secrets', async () => {
      const a = await enrolled(coA, 'OWNER');
      const owner2 = await enrolled(coA, 'OWNER');
      const t = await enrolled(coA, 'CASHIER');
      const foreign = await enrolled(coB, 'CASHIER');
      const rows = (targetUserId: string) =>
        tenantPrisma.run(coA, (tx) => tx.auditLog.findMany({ where: { userId: a.id, action: 'auth.mfa.reset_reauth_rejected' } })).then((all) => all.filter((r) => (r.newValue as { targetUserId?: string }).targetUserId === targetUserId));
      const expectOne = async (targetUserId: string, reason: string) => {
        const found = await rows(targetUserId);
        expect(found).toHaveLength(1);
        expect(found[0].newValue).toEqual({ stage: 'precheck', reason, targetUserId });
        expect(JSON.stringify(found[0].newValue)).not.toContain(pw);
      };
      const mine = (await svc.createMfaResetChallenge(t.id, asActor(a))).challengeId;
      await expect(doReset(a, a.id, mine)).rejects.toBeInstanceOf(CannotResetOwnMfaException);
      await expectOne(a.id, 'USER_CANNOT_RESET_OWN_MFA');
      const forOwner = (await svc.createMfaResetChallenge(t.id, asActor(a))).challengeId;
      await expect(doReset(a, owner2.id, forOwner)).rejects.toBeInstanceOf(MfaChallengeInvalidException); // challenge bound to t
      await expect(svc.createMfaResetChallenge(owner2.id, asActor(a))).rejects.toBeInstanceOf(CannotResetOwnerMfaException);
      expect(await rows(owner2.id)).toHaveLength(2);
      await expect(svc.createMfaResetChallenge(foreign.id, asActor(a))).rejects.toBeInstanceOf(UserNotFoundException);
      await expectOne(foreign.id, 'USER_NOT_FOUND');
      await expect(doReset(a, t.id, 'x'.repeat(43))).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      const tRows = await rows(t.id);
      expect(tRows).toHaveLength(1);
      expect(tRows[0].newValue).toMatchObject({ stage: 'precheck' });
      await expectIntact(t);
      await expectIntact(owner2);
    });

    it('ADR-058: a consumed challenge cannot be reused', async () => {
      const a = await enrolled(coA, 'OWNER');
      const t = await enrolled(coA, 'CASHIER');
      const { challengeId } = await svc.createMfaResetChallenge(t.id, asActor(a));
      await doReset(a, t.id, challengeId);
      await expect(doReset(a, t.id, challengeId)).rejects.toBeInstanceOf(MfaChallengeInvalidException);
    });

    it('ADR-058: failure inside the final tx rolls back MFA, recovery codes, sessions and enrollment codes', async () => {
      const a = await enrolled(coA, 'OWNER');
      const t = await enrolled(coA, 'CASHIER');
      const failing = { log: (tx: never, e: { action: string }) => (e.action === 'auth.mfa.reset' ? Promise.reject(new Error('boom')) : auditLog.log(tx, e as never)) } as unknown as AuditLogService;
      const bad = new UsersService(tenantPrisma, failing, mfaSvc, store);
      const before = await systemPrisma.mfaEnrollmentCode.count({ where: { userId: t.id } });
      const { challengeId } = await bad.createMfaResetChallenge(t.id, asActor(a));
      await expect(doReset(a, t.id, challengeId, {}, bad)).rejects.toThrow('boom');
      await expectIntact(t);
      expect(await systemPrisma.mfaEnrollmentCode.count({ where: { userId: t.id } })).toBe(before);
      expect(await systemPrisma.mfaEnrollmentCode.count({ where: { userId: t.id, usedAt: null } })).toBe(0);
    });
  });
});
