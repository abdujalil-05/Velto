// Runs inside a systemPrisma transaction that is always rolled back, scoped to
// one fresh company: nothing here survives the test or touches other tenants.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { systemPrisma, type TenantClient } from '../client';
import { backfillPermissions } from '../backfill-permissions';
import { ALL_PERMISSION_KEYS, SYSTEM_ROLES, parsePermissionKey, permissionKeysForRole } from '../rbac-catalog';

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

describe('backfill-permissions', () => {
  it('dry run writes nothing; real run is additive and idempotent; SALES_AGENT gets no stock.movements.read', { timeout: 60_000 }, async () => {
    await inRolledBackTx(async (tx) => {
      const tenant = await tx.tenant.create({ data: { slug: `backfill-${randomUUID()}`, name: 'Backfill Tenant' } });
      const company = await tx.company.create({ data: { tenantId: tenant.id, name: 'Backfill Co' } });
      const companyIds = [company.id];
      const roleIdByCode = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const created = await tx.role.create({ data: { companyId: company.id, code: role.code, name: role.name, isSystem: true } });
        roleIdByCode.set(role.code, created.id);
      }
      const expectedLinks = SYSTEM_ROLES.reduce((sum, role) => sum + permissionKeysForRole(role.code).length, 0);
      // Permission is global and other test files commit unrelated rows concurrently
      // (e.g. tenant-isolation's test.isolation): count only catalog keys and this company's links.
      const catalogPermissions = ALL_PERMISSION_KEYS.map(parsePermissionKey);
      const rowCounts = async () => [
        await tx.permission.count({ where: { OR: catalogPermissions } }),
        await tx.rolePermission.count({ where: { role: { companyId: company.id } } }),
      ];

      const before = await rowCounts();
      const dry = await backfillPermissions(tx, { dryRun: true, companyIds });
      expect(await rowCounts()).toEqual(before);
      expect(dry).toMatchObject({ companiesProcessed: 1, linksAdded: expectedLinks });

      const real = await backfillPermissions(tx, { dryRun: false, companyIds });
      expect(real).toEqual(dry);

      const again = await backfillPermissions(tx, { dryRun: false, companyIds });
      expect(again).toEqual({ companiesProcessed: 1, permissionsCreated: 0, linksAdded: 0 });

      const holds = async (roleCode: string, key: string) =>
        (await tx.rolePermission.count({
          where: { roleId: roleIdByCode.get(roleCode)!, permission: parsePermissionKey(key) },
        })) === 1;
      expect(await holds('SALES_AGENT', 'stock.read')).toBe(true);
      expect(await holds('SALES_AGENT', 'stock.movements.read')).toBe(false);
      for (const code of ['OWNER', 'SALES_DIRECTOR', 'WAREHOUSE']) expect(await holds(code, 'stock.movements.read'), code).toBe(true);
      expect(await holds('OWNER', 'customers.restore')).toBe(true);
      expect(await holds('SALES_DIRECTOR', 'customers.restore')).toBe(false);
    });
  });
});
