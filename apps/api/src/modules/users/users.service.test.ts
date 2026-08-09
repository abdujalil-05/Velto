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
import { UsersService } from './users.service';

describe('UsersService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let actor: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const users = new UsersService(tenantPrisma, auditLog);

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

      const result = await tenantPrisma.run(companyId, () => users.remove(created.id, {}, actor));
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

      const result = await tenantPrisma.run(companyId, () => users.remove(created.id, {}, actor));
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
        tenantPrisma.run(companyId, () => users.remove(created.id, { hard: true }, actor)),
      ).rejects.toBeInstanceOf(UserHasReferencesException);

      const row = await tenantPrisma.run(companyId, (tx) => tx.user.findUnique({ where: { id: created.id } }));
      expect(row).not.toBeNull();
    });

    it('writes an audit entry that outlives the hard-deleted row', async () => {
      const created = await tenantPrisma.run(companyId, () => users.create(dto(), actor));
      await tenantPrisma.run(companyId, () => users.remove(created.id, {}, actor));

      const entries = await tenantPrisma.run(companyId, (tx) =>
        tx.auditLog.findMany({ where: { entity: 'User', entityId: created.id, action: 'user.delete' } }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe(actor.id);
    });

    it('refuses to let a user delete their own account', async () => {
      await expect(tenantPrisma.run(companyId, () => users.remove(actor.id, {}, actor))).rejects.toBeInstanceOf(
        CannotDeleteSelfException,
      );
    });

    it("refuses to delete the tenant's sole remaining OWNER", async () => {
      const { companyId: isolatedCompanyId, freshActor } = await createIsolatedCompany();
      const soleOwner = await tenantPrisma.run(isolatedCompanyId, () =>
        users.create(dto({ roleCodes: ['OWNER'] }), freshActor),
      );

      await expect(
        tenantPrisma.run(isolatedCompanyId, () => users.remove(soleOwner.id, {}, freshActor)),
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
        tenantPrisma.run(isolatedCompanyId, () => users.remove(otherOwner.id, {}, director)),
      ).rejects.toBeInstanceOf(CannotDeleteOwnerException);
    });
  });
});
