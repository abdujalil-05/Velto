// One-off, idempotent data fix: the COURIER system role ("Kuryer") was added
// to rbac-catalog.ts after tenants had already been provisioned. seed.ts and
// bootstrap-owner.ts only ever run against a fresh database, and
// backfill-permissions.ts deliberately does not create missing Role rows
// ("role creation is out of scope here" — it only adds grants to roles that
// exist), so without this script an existing tenant has no COURIER role at all
// and no courier can be created in the UI.
//
// Creates the missing Role row per company and grants it the catalog's
// permission set; skips any company that already has it. Never updates or
// deletes an existing row.
//
// Cross-tenant by definition, so it runs on `systemPrisma` (role
// `velto_system`, BYPASSRLS) — the legitimate platform-admin case, same as
// backfill-permissions.ts. Every query is still explicitly scoped by
// companyId / roleId so a bug cannot silently touch the wrong tenant.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/backfill-courier-role.ts
//   pnpm --filter @velto/database exec tsx src/backfill-courier-role.ts --dry-run
import 'dotenv/config';
import { systemPrisma } from './index';
import { SYSTEM_ROLES, permissionKeysForRole } from './rbac-catalog';

const DRY_RUN = process.argv.includes('--dry-run');

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BACKFILL !== '1') {
  console.error(
    'Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_BACKFILL=1 once reviewed (try --dry-run first).',
  );
  process.exit(1);
}

const ROLE_CODE = 'COURIER';

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no writes will be performed.\n');

  const roleDef = SYSTEM_ROLES.find((r) => r.code === ROLE_CODE);
  if (!roleDef) throw new Error(`${ROLE_CODE} is missing from SYSTEM_ROLES — nothing to backfill.`);

  const keys = permissionKeysForRole(ROLE_CODE);
  const permissions = await systemPrisma.permission.findMany({ select: { id: true, module: true, code: true } });
  const idByKey = new Map(permissions.map((p) => [`${p.module}.${p.code}`, p.id]));

  const companies = await systemPrisma.company.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  let created = 0;
  for (const company of companies) {
    const existing = await systemPrisma.role.findFirst({
      where: { companyId: company.id, code: ROLE_CODE },
      select: { id: true },
    });
    if (existing) {
      console.log(`  = ${company.name}: ${ROLE_CODE} already present`);
      continue;
    }

    const grants = keys
      .map((key) => ({ key, permissionId: idByKey.get(key) }))
      .filter((entry): entry is { key: string; permissionId: string } => {
        if (!entry.permissionId) {
          // Permission rows are global reference data; backfill-permissions.ts
          // creates the missing ones. Run it first if this warns.
          console.warn(`  ! ${company.name}: no Permission row for "${entry.key}" — skipped`);
          return false;
        }
        return true;
      });

    console.log(`  + ${company.name}: ${ROLE_CODE} (${grants.map((g) => g.key).join(', ')})`);
    if (DRY_RUN) {
      created += 1;
      continue;
    }

    const role = await systemPrisma.role.create({
      data: { companyId: company.id, code: ROLE_CODE, name: roleDef.name, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: grants.map((g) => ({ roleId: role.id, permissionId: g.permissionId })),
      skipDuplicates: true,
    });
    created += 1;
  }

  console.log('\n--- Summary ---');
  console.log(`Companies processed:  ${companies.length}`);
  console.log(`${ROLE_CODE} roles created: ${created}`);
  if (DRY_RUN) console.log('(dry run — nothing was written)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
