// One-off, idempotent data fix: seed.ts / bootstrap-owner.ts only ever run
// against a fresh database, so a permission added to the catalog later
// (rbac-catalog.ts) never reaches tenants that were already provisioned —
// their roles keep the grant set they were created with and the API answers
// 403 to everyone, Owner included (e.g. `users.delete`). This script walks
// every Company and adds whatever the catalog says is missing.
//
// Purely additive and safe to re-run: it creates missing global Permission
// rows and missing RolePermission links, and never updates or deletes an
// existing row — a grant revoked deliberately in the DB is re-added only if
// the catalog still lists it, and nothing is ever taken away here.
//
// Cross-tenant by definition, so it runs on `systemPrisma` (role
// `velto_system`, BYPASSRLS) — the legitimate platform-admin case. The
// ordinary `prisma` client would see zero rows for every tenant. Every query
// below is still explicitly scoped by companyId / roleId so a bug cannot
// silently touch the wrong tenant.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/backfill-permissions.ts
//   pnpm --filter @velto/database exec tsx src/backfill-permissions.ts --dry-run
//
// Against a production database (nothing is written without this):
//   NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1 pnpm --filter @velto/database exec tsx src/backfill-permissions.ts
import 'dotenv/config';
import { systemPrisma } from './index';
import { ALL_PERMISSION_KEYS, ROLE_PERMISSIONS, permissionKeysForRole } from './rbac-catalog';

const DRY_RUN = process.argv.includes('--dry-run');

// Unlike the other one-off scripts this one legitimately targets live tenants,
// so production is allowed — but only when asked for explicitly.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BACKFILL !== '1') {
  console.error(
    'Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_BACKFILL=1 once reviewed (try --dry-run first).',
  );
  process.exit(1);
}

const SYSTEM_ROLE_CODES = Object.keys(ROLE_PERMISSIONS);

function splitKey(key: string): { module: string; code: string } {
  const [module, code] = key.split('.');
  return { module: module!, code: code! };
}

/**
 * Permission is global reference data (schema 6.2, not tenant-scoped) — there
 * is one row per "module.action" for the whole install, so this runs once, not
 * per company.
 */
async function ensurePermissions(): Promise<{ idByKey: Map<string, string>; created: number }> {
  const existing = await systemPrisma.permission.findMany({ select: { id: true, module: true, code: true } });
  const idByKey = new Map(existing.map((p) => [`${p.module}.${p.code}`, p.id]));

  const missing = ALL_PERMISSION_KEYS.filter((key) => !idByKey.has(key));
  if (missing.length === 0) return { idByKey, created: 0 };

  console.log(`Missing Permission rows: ${missing.join(', ')}`);
  if (DRY_RUN) {
    // Stand-in ids so the per-role counts below reflect what a real run would
    // grant, instead of reporting the not-yet-created permissions as skipped.
    for (const key of missing) idByKey.set(key, `dry-run:${key}`);
    return { idByKey, created: missing.length };
  }

  const result = await systemPrisma.permission.createMany({
    data: missing.map(splitKey),
    skipDuplicates: true,
  });

  const refreshed = await systemPrisma.permission.findMany({ select: { id: true, module: true, code: true } });
  return {
    idByKey: new Map(refreshed.map((p) => [`${p.module}.${p.code}`, p.id])),
    created: result.count,
  };
}

async function backfillCompany(
  company: { id: string; name: string },
  permissionIdByKey: Map<string, string>,
): Promise<number> {
  // Matched on `code`, not on `isSystem`: role codes are what the app keys off
  // (users.service.ts, cash-sessions.service.ts), and MVP has no custom-role
  // authoring, so a catalog code always means the system role.
  const roles = await systemPrisma.role.findMany({
    where: { companyId: company.id, code: { in: SYSTEM_ROLE_CODES } },
    select: { id: true, code: true, companyId: true },
  });

  const foundCodes = new Set(roles.map((r) => r.code));
  const absent = SYSTEM_ROLE_CODES.filter((code) => !foundCodes.has(code));
  if (absent.length > 0) {
    console.warn(`  ! ${company.name}: no Role row for ${absent.join(', ')} — role creation is out of scope here`);
  }

  let added = 0;
  for (const role of roles) {
    if (role.companyId !== company.id) throw new Error(`Role ${role.id} is not owned by company ${company.id}`);

    const held = new Set(
      (
        await systemPrisma.rolePermission.findMany({
          where: { roleId: role.id },
          select: { permissionId: true },
        })
      ).map((rp) => rp.permissionId),
    );

    const toAdd = permissionKeysForRole(role.code)
      .map((key) => ({ key, permissionId: permissionIdByKey.get(key) }))
      .filter((entry): entry is { key: string; permissionId: string } => {
        if (!entry.permissionId) {
          console.warn(`  ! ${company.name}/${role.code}: no Permission row for "${entry.key}" — skipped`);
          return false;
        }
        return !held.has(entry.permissionId);
      });

    if (toAdd.length === 0) continue;

    console.log(`  ${company.name}/${role.code}: +${toAdd.length} (${toAdd.map((e) => e.key).join(', ')})`);
    if (DRY_RUN) {
      added += toAdd.length;
      continue;
    }

    const result = await systemPrisma.rolePermission.createMany({
      data: toAdd.map((entry) => ({ roleId: role.id, permissionId: entry.permissionId })),
      skipDuplicates: true,
    });
    added += result.count;
  }

  return added;
}

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no writes will be performed.\n');

  const { idByKey, created: permissionsCreated } = await ensurePermissions();

  const companies = await systemPrisma.company.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  let linksCreated = 0;
  for (const company of companies) {
    linksCreated += await backfillCompany(company, idByKey);
  }

  console.log('\n--- Summary ---');
  console.log(`Companies processed:        ${companies.length}`);
  console.log(`Permission rows created:    ${permissionsCreated}`);
  console.log(`RolePermission links added: ${linksCreated}`);
  if (DRY_RUN) console.log('(dry run — nothing was written)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
