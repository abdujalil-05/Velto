// ADR-058 platform MFA recovery script. Company/Tenant rows are left behind on
// purpose: the AuditLog row the reset writes is append-only and FK-restricts
// deleting its Company (same trade-off as tenant-isolation.test.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPrisma, withTenant } from '../client';
import { MFA_RESET_AUDIT_ACTION, parseResetUserMfaArgs, resetUserMfa } from '../reset-user-mfa';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';

async function enroll(companyId: string, userId: string) {
  return withTenant(companyId, async (tx) => {
    const mfa = await tx.userMfa.create({
      data: {
        companyId,
        userId,
        secretCiphertext: Buffer.from('ct'),
        secretIv: Buffer.alloc(12),
        secretTag: Buffer.alloc(16),
        keyVersion: 1,
        confirmedAt: new Date(),
      },
    });
    await tx.userMfaRecoveryCode.createMany({
      data: [1, 2].map(() => ({ companyId, userId, codeHash: HASH })),
    });
    await tx.refreshToken.create({
      data: {
        userId,
        tokenHash: randomUUID(),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaId: mfa.id,
      },
    });
    return mfa;
  });
}

describe('reset-user-mfa (ADR-058)', () => {
  let companyAId: string;
  let companyBId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-mfa-reset-${Date.now()}`, name: 'MFA Reset Test' },
    });
    const [a, b] = await Promise.all([
      systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'MFA Reset Co A' } }),
      systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'MFA Reset Co B' } }),
    ]);
    companyAId = a.id;
    companyBId = b.id;
    const stamp = Date.now();
    userAId = (
      await systemPrisma.user.create({
        data: { companyId: companyAId, firstName: 'A', lastName: 'Owner', phone: `+99890${stamp}`.slice(0, 13) },
      })
    ).id;
    userBId = (
      await systemPrisma.user.create({
        data: { companyId: companyBId, firstName: 'B', lastName: 'Owner', phone: `+99891${stamp}`.slice(0, 13) },
      })
    ).id;
    await enroll(companyAId, userAId);
    await enroll(companyBId, userBId);
  });

  afterAll(async () => {
    const users = { userId: { in: [userAId, userBId] } };
    await systemPrisma.refreshToken.deleteMany({ where: users });
    await systemPrisma.userMfaRecoveryCode.deleteMany({ where: users });
    await systemPrisma.userMfa.deleteMany({ where: users });
    await systemPrisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await systemPrisma.$disconnect();
  });

  it('refuses when any argument is missing, blank or not a UUID', () => {
    const id = randomUUID();
    expect(() => parseResetUserMfaArgs([])).toThrow(/Refusing/);
    expect(() => parseResetUserMfaArgs([id, id, 'lost phone'])).toThrow(/Refusing/);
    expect(() => parseResetUserMfaArgs([id, id, '  ', 'ops'])).toThrow(/Refusing/);
    expect(() => parseResetUserMfaArgs(['x', id, 'lost phone', 'ops'])).toThrow(/UUID/);
    expect(parseResetUserMfaArgs([id, id, 'lost phone', 'ops'])).toEqual({
      companyId: id,
      userId: id,
      reason: 'lost phone',
      operatorName: 'ops',
    });
  });

  it('refuses a user that does not belong to the given company, writing nothing', async () => {
    await expect(
      resetUserMfa({ companyId: companyBId, userId: userAId, reason: 'lost phone', operatorName: 'ops' }),
    ).rejects.toThrow(/not found/);
    expect(await systemPrisma.userMfa.count({ where: { userId: userAId } })).toBe(1);
  });

  it('deletes MFA + recovery codes, revokes sessions, audits, and leaves other tenants untouched', async () => {
    const result = await resetUserMfa({
      companyId: companyAId,
      userId: userAId,
      reason: 'lost phone and codes',
      operatorName: 'Platform Ops',
    });
    expect(result).toMatchObject({ mfaDeleted: 1, recoveryCodesDeleted: 2, refreshTokensRevoked: 1 });

    expect(await systemPrisma.userMfa.count({ where: { userId: userAId } })).toBe(0);
    expect(await systemPrisma.userMfaRecoveryCode.count({ where: { userId: userAId } })).toBe(0);
    const tokens = await systemPrisma.refreshToken.findMany({ where: { userId: userAId } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.revokedAt).not.toBeNull();
    expect(tokens[0]!.mfaId).toBeNull(); // ON DELETE SET NULL

    const audit = await systemPrisma.auditLog.findUniqueOrThrow({ where: { id: result.auditLogId } });
    expect(audit).toMatchObject({
      companyId: companyAId,
      userId: null,
      action: MFA_RESET_AUDIT_ACTION,
      entity: 'User',
      entityId: userAId,
      newValue: { actor: 'platform', operatorName: 'Platform Ops', reason: 'lost phone and codes' },
    });

    // Company B's user is untouched.
    expect(await systemPrisma.userMfa.count({ where: { userId: userBId } })).toBe(1);
    expect(await systemPrisma.userMfaRecoveryCode.count({ where: { userId: userBId } })).toBe(2);
    expect(await systemPrisma.refreshToken.count({ where: { userId: userBId, revokedAt: null } })).toBe(1);

    // Idempotent: a second run finds nothing left to clear.
    const again = await resetUserMfa({ companyId: companyAId, userId: userAId, reason: 'retry', operatorName: 'ops' });
    expect(again).toMatchObject({ mfaDeleted: 0, recoveryCodesDeleted: 0, refreshTokensRevoked: 0 });
  });
});
