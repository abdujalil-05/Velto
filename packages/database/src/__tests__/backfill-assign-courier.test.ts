// Runs inside a systemPrisma transaction that is always rolled back, scoped to
// synthetic companies: nothing here survives the test or touches other tenants.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { systemPrisma, type TenantClient } from '../client';
import { ensurePermissions } from '../backfill-permissions';
import { backfillAssignCourier, CHANGES, NEW_PERMISSION_GRANTS, NEW_PERMISSIONS } from '../backfill-assign-courier';
import { SYSTEM_ROLES, parsePermissionKey, permissionKeysForRole } from '../rbac-catalog';

class Rollback extends Error {}

async function inRolledBackTx(fn: (tx: TenantClient) => Promise<void>): Promise<void> {
  const outcome = await systemPrisma
    .$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 60_000 },
    )
    .catch((err: unknown) => err);
  if (!(outcome instanceof Rollback)) throw outcome;
}

/** Grants a tenant provisioned before the PO decision holds. */
function oldCatalogKeys(roleCode: string): string[] {
  const keys = new Set(permissionKeysForRole(roleCode));
  for (const g of CHANGES.add) if (g.role === roleCode) keys.delete(g.key);
  for (const g of CHANGES.revoke) if (g.role === roleCode) keys.add(g.key);
  return [...keys];
}

const MANUAL_EXTRA = { role: 'CASHIER', key: 'reports.read' };
const sortGrants = (gs: { role: string; key: string }[]) => [...gs].sort((x, y) => `${x.role}:${x.key}`.localeCompare(`${y.role}:${y.key}`));

describe('backfill-assign-courier', () => {
  it('dry run reports only; apply fixes old grants, keeps manual extras; second apply = 0; fresh company matches', { timeout: 60_000 }, async () => {
    await inRolledBackTx(async (tx) => {
      const { idByKey } = await ensurePermissions(tx, false);
      const tenant = await tx.tenant.create({ data: { slug: `assign-courier-${randomUUID()}`, name: 'AC Tenant' } });

      const makeCompany = async (name: string, keysFor: (code: string) => string[]) => {
        const company = await tx.company.create({ data: { tenantId: tenant.id, name } });
        const roleIdByCode = new Map<string, string>();
        for (const role of SYSTEM_ROLES) {
          const created = await tx.role.create({ data: { companyId: company.id, code: role.code, name: role.name, isSystem: true } });
          roleIdByCode.set(role.code, created.id);
          await tx.rolePermission.createMany({
            data: keysFor(role.code).map((key) => ({ roleId: created.id, permissionId: idByKey.get(key)! })),
          });
        }
        return { id: company.id, roleIdByCode };
      };
      const a = await makeCompany('AC Old', oldCatalogKeys);
      const b = await makeCompany('AC Manual', (code) => (code === MANUAL_EXTRA.role ? [...oldCatalogKeys(code), MANUAL_EXTRA.key] : oldCatalogKeys(code)));
      const fresh = await makeCompany('AC Fresh', permissionKeysForRole);
      const companyIds = [a.id, b.id, fresh.id];

      const snapshot = async () => [
        await tx.rolePermission.count({ where: { role: { companyId: { in: companyIds } } } }),
        await tx.auditLog.count({ where: { companyId: { in: companyIds } } }),
      ];
      const holds = async (c: { roleIdByCode: Map<string, string> }, role: string, key: string) =>
        (await tx.rolePermission.count({ where: { roleId: c.roleIdByCode.get(role)!, permission: parsePermissionKey(key) } })) === 1;

      const before = await snapshot();
      const dry = await backfillAssignCourier(tx, { dryRun: true, companyIds });
      expect(await snapshot()).toEqual(before);
      const byId = new Map(dry.companies.map((c) => [c.companyId, c]));
      for (const c of [a, b]) expect(sortGrants(byId.get(c.id)!.toAdd)).toEqual(sortGrants(CHANGES.add));
      expect(byId.get(a.id)).toMatchObject({ toRevoke: CHANGES.revoke, missing: [], extra: [] });
      expect(byId.get(b.id)).toMatchObject({ toRevoke: CHANGES.revoke, missing: [], extra: [MANUAL_EXTRA] });
      expect(byId.get(fresh.id)).toMatchObject({ toAdd: [], toRevoke: [], missing: [], extra: [] });
      expect(dry).toMatchObject({ grantsAdded: 2 * CHANGES.add.length, grantsRevoked: 2 * CHANGES.revoke.length });

      const applied = await backfillAssignCourier(tx, { dryRun: false, companyIds });
      expect(applied).toMatchObject({ permissionsCreated: 0, grantsAdded: dry.grantsAdded, grantsRevoked: dry.grantsRevoked });
      for (const c of [a, b]) {
        expect(await holds(c, 'WAREHOUSE', 'orders.update')).toBe(false);
        for (const g of CHANGES.add) expect(await holds(c, g.role, g.key), `${g.role}:${g.key}`).toBe(true);
      }
      expect(await holds(b, MANUAL_EXTRA.role, MANUAL_EXTRA.key)).toBe(true);
      expect(await tx.auditLog.count({ where: { companyId: { in: companyIds }, action: 'role.permission.sync' } })).toBe(2);

      const again = await backfillAssignCourier(tx, { dryRun: false, companyIds });
      expect(again).toMatchObject({ permissionsCreated: 0, grantsAdded: 0, grantsRevoked: 0 });
      expect(again.companies.find((c) => c.companyId === b.id)?.extra).toEqual([MANUAL_EXTRA]);
      expect(await tx.auditLog.count({ where: { companyId: { in: companyIds }, action: 'role.permission.sync' } })).toBe(2);
    });
  });

  it('creates missing new Permission rows (dry run writes nothing); grants them to exactly the listed roles; second apply = 0', { timeout: 60_000 }, async () => {
    await inRolledBackTx(async (tx) => {
      // Simulate a database provisioned before the new keys existed. Permission is a
      // global table: lock it first (readers unaffected; writers wait max 5s, then fail instead of hanging).
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`LOCK TABLE "Permission" IN SHARE ROW EXCLUSIVE MODE`;
      const newPerms = NEW_PERMISSIONS.map(parsePermissionKey);
      await tx.rolePermission.deleteMany({ where: { permission: { OR: newPerms } } });
      await tx.permission.deleteMany({ where: { OR: newPerms } });
      const { idByKey } = await ensurePermissions(tx, false, permissionKeysForRole('OWNER').filter((k) => !NEW_PERMISSIONS.includes(k)));
      const tenant = await tx.tenant.create({ data: { slug: `assign-courier-${randomUUID()}`, name: 'AC Tenant 2' } });
      const company = await tx.company.create({ data: { tenantId: tenant.id, name: 'AC Pre-perm' } });
      const roleIdByCode = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const created = await tx.role.create({ data: { companyId: company.id, code: role.code, name: role.name, isSystem: true } });
        roleIdByCode.set(role.code, created.id);
        await tx.rolePermission.createMany({ data: oldCatalogKeys(role.code).map((key) => ({ roleId: created.id, permissionId: idByKey.get(key)! })) });
      }
      const companyIds = [company.id];
      const snapshot = async () => [
        await tx.permission.count(),
        await tx.rolePermission.count({ where: { role: { companyId: company.id } } }),
        await tx.auditLog.count({ where: { companyId: company.id } }),
      ];

      const before = await snapshot();
      const dry = await backfillAssignCourier(tx, { dryRun: true, companyIds });
      expect(await snapshot()).toEqual(before);
      expect(dry).toMatchObject({ dryRun: true, permissionsCreated: NEW_PERMISSIONS.length, grantsAdded: CHANGES.add.length, grantsRevoked: CHANGES.revoke.length });
      expect(await tx.permission.count({ where: { OR: newPerms } })).toBe(0);

      const applied = await backfillAssignCourier(tx, { dryRun: false, companyIds });
      expect(applied).toMatchObject({ permissionsCreated: NEW_PERMISSIONS.length, grantsAdded: CHANGES.add.length, grantsRevoked: CHANGES.revoke.length });
      expect(applied.companies[0]).toMatchObject({ missing: [], extra: [] });
      for (const [key, roles] of Object.entries(NEW_PERMISSION_GRANTS)) {
        const holders = await tx.rolePermission.findMany({
          where: { role: { companyId: company.id }, permission: parsePermissionKey(key) },
          select: { role: { select: { code: true } } },
        });
        expect(holders.map((h) => h.role.code).sort(), key).toEqual([...roles].sort());
      }

      const after = await snapshot();
      const again = await backfillAssignCourier(tx, { dryRun: false, companyIds });
      expect(again).toMatchObject({ permissionsCreated: 0, grantsAdded: 0, grantsRevoked: 0 });
      expect(await snapshot()).toEqual(after);
    });
  });
});
