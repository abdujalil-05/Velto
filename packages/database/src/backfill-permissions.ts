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
//   ... --company=<uuid> [--company=<uuid>]   (limit the per-role pass to these companies)
//
// Against a production database (nothing is written without this):
//   NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1 pnpm --filter @velto/database exec tsx src/backfill-permissions.ts
import 'dotenv/config';
import { systemPrisma, type TenantClient } from './index';
import { ALL_PERMISSION_KEYS, ROLE_PERMISSIONS, parsePermissionKey, permissionKeysForRole } from './rbac-catalog';

/** Accepts `systemPrisma` itself or one of its transactions (tests roll back). */
type Db = TenantClient;

export type BackfillOptions = { dryRun: boolean; companyIds?: string[] };
export type BackfillResult = { companiesProcessed: number; permissionsCreated: number; linksAdded: number };

const SYSTEM_ROLE_CODES = Object.keys(ROLE_PERMISSIONS);

/**
 * Permission is global reference data (schema 6.2, not tenant-scoped) — there
 * is one row per "module.action" for the whole install, so this runs once, not
 * per company.
 */
async function ensurePermissions(db: Db, dryRun: boolean): Promise<{ idByKey: Map<string, string>; created: number }> {
  const existing = await db.permission.findMany({ select: { id: true, module: true, code: true } });
  const idByKey = new Map(existing.map((p) => [`${p.module}.${p.code}`, p.id]));

  const missing = ALL_PERMISSION_KEYS.filter((key) => !idByKey.has(key));
  if (missing.length === 0) return { idByKey, created: 0 };

  console.log(`Missing Permission rows: ${missing.join(', ')}`);
  if (dryRun) {
    // Stand-in ids so the per-role counts below reflect what a real run would
    // grant, instead of reporting the not-yet-created permissions as skipped.
    for (const key of missing) idByKey.set(key, `dry-run:${key}`);
    return { idByKey, created: missing.length };
  }

  const result = await db.permission.createMany({
    data: missing.map(parsePermissionKey),
    skipDuplicates: true,
  });

  const refreshed = await db.permission.findMany({ select: { id: true, module: true, code: true } });
  return {
    idByKey: new Map(refreshed.map((p) => [`${p.module}.${p.code}`, p.id])),
    created: result.count,
  };
}

async function backfillCompany(
  db: Db,
  dryRun: boolean,
  company: { id: string; name: string },
  permissionIdByKey: Map<string, string>,
): Promise<number> {
  // Matched on `code`, not on `isSystem`: role codes are what the app keys off
  // (users.service.ts, cash-sessions.service.ts), and MVP has no custom-role
  // authoring, so a catalog code always means the system role.
  const roles = await db.role.findMany({
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
        await db.rolePermission.findMany({
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
    if (dryRun) {
      added += toAdd.length;
      continue;
    }

    const result = await db.rolePermission.createMany({
      data: toAdd.map((entry) => ({ roleId: role.id, permissionId: entry.permissionId })),
      skipDuplicates: true,
    });
    added += result.count;
  }

  return added;
}

/** Additive and idempotent: a second run reports 0 created / 0 added. A dry run writes nothing. */
export async function backfillPermissions(db: Db, { dryRun, companyIds }: BackfillOptions): Promise<BackfillResult> {
  const { idByKey, created: permissionsCreated } = await ensurePermissions(db, dryRun);

  const companies = await db.company.findMany({
    where: companyIds ? { id: { in: companyIds } } : undefined,
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  let linksAdded = 0;
  for (const company of companies) {
    linksAdded += await backfillCompany(db, dryRun, company, idByKey);
  }
  return { companiesProcessed: companies.length, permissionsCreated, linksAdded };
}

async function main() {
  // Unlike the other one-off scripts this one legitimately targets live tenants,
  // so production is allowed — but only when asked for explicitly.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BACKFILL !== '1') {
    throw new Error(
      'Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_BACKFILL=1 once reviewed (try --dry-run first).',
    );
  }
  const dryRun = process.argv.includes('--dry-run');
  const companyArgs = process.argv.filter((arg) => arg.startsWith('--company=')).map((arg) => arg.slice('--company='.length));
  if (dryRun) console.log('DRY RUN — no writes will be performed.\n');

  const result = await backfillPermissions(systemPrisma, {
    dryRun,
    companyIds: companyArgs.length > 0 ? companyArgs : undefined,
  });

  console.log('\n--- Summary ---');
  console.log(`Companies processed:        ${result.companiesProcessed}`);
  console.log(`Permission rows created:    ${result.permissionsCreated}`);
  console.log(`RolePermission links added: ${result.linksAdded}`);
  if (dryRun) console.log('(dry run — nothing was written)');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
