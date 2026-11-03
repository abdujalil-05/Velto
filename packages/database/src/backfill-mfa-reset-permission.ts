// ADR-058 one-off, idempotent data fix: `users.mfa_reset` was added to the
// catalog after tenants were provisioned. Grants it to the roles the catalog
// says hold it (OWNER only) in every company — nothing else. Narrower than
// backfill-permissions.ts on purpose: that one also fills every other gap a
// tenant may have, which is a separate decision.
//
// Purely additive: creates the global Permission row if missing and missing
// RolePermission links; never updates or deletes. Safe to re-run (no-op).
// Cross-tenant by definition -> systemPrisma, every query scoped by roleId.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/backfill-mfa-reset-permission.ts [--dry-run]
// Production (nothing is written without the explicit opt-in):
//   NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1 pnpm --filter @velto/database exec tsx src/backfill-mfa-reset-permission.ts
import 'dotenv/config';
import { systemPrisma } from './index';
import { ROLE_PERMISSIONS, parsePermissionKey, permissionKeysForRole } from './rbac-catalog';

const KEY = 'users.mfa_reset';
const DRY_RUN = process.argv.includes('--dry-run');

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BACKFILL !== '1') {
  console.error('Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_BACKFILL=1 once reviewed (try --dry-run first).');
  process.exit(1);
}

async function main() {
  const { module, code } = parsePermissionKey(KEY);
  const roleCodes = Object.keys(ROLE_PERMISSIONS).filter((c) => permissionKeysForRole(c).includes(KEY));

  let permission = await systemPrisma.permission.findUnique({ where: { module_code: { module, code } } });
  if (!permission && !DRY_RUN) permission = await systemPrisma.permission.create({ data: { module, code } });

  const roles = await systemPrisma.role.findMany({
    where: {
      code: { in: roleCodes },
      ...(permission ? { permissions: { none: { permissionId: permission.id } } } : {}),
    },
    select: { id: true },
  });

  if (DRY_RUN || !permission) {
    console.log(`DRY RUN: ${KEY} -> ${roleCodes.join(', ')}; would grant to ${roles.length} role(s)`);
    return;
  }
  const result = await systemPrisma.rolePermission.createMany({
    data: roles.map((role) => ({ roleId: role.id, permissionId: permission.id })),
    skipDuplicates: true,
  });
  console.log(`${KEY} -> ${roleCodes.join(', ')}: ${result.count} RolePermission link(s) added`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => systemPrisma.$disconnect());
