// Idempotent data fix: seed.ts / bootstrap-owner.ts only ever run against a
// fresh database, so a *role* added to the catalog later (rbac-catalog.ts)
// never reaches tenants that were already provisioned — e.g. COURIER (added
// with 20260810170000_couriers_replace_suppliers) is missing on every tenant
// created before it, and POST /users then rejects the role with
// InvalidRoleCodesException ("Noto'g'ri rol kodi: COURIER", see
// apps/api/src/modules/users/users.service.ts).
//
// This is the role-level companion to backfill-permissions.ts: it walks every
// Company, creates whatever SYSTEM_ROLES row is missing (isSystem: true) and
// then brings every system role's grants up to ROLE_PERMISSIONS, creating the
// global Permission rows it needs on the way.
//
// Purely additive and safe to re-run: roles are upserted by (companyId, code)
// and never renamed here (display-name changes are a separate one-off, see
// rename-system-roles.ts), grants are only added, nothing is ever updated or
// deleted. A second run on an already-synced database prints all zeroes.
//
// Multi-tenancy (CLAUDE.md / TZ 6.10): listing companies is cross-tenant by
// definition, so only that read uses `systemPrisma` (role `velto_system`,
// BYPASSRLS). Permission is global reference data (schema 6.2, no companyId,
// no RLS) and is likewise upserted through it. Every tenant-scoped write —
// Role, RolePermission — goes through `withTenant(companyId, ...)`, so RLS
// itself (not just this code) guarantees a row can only land in the company
// whose context is open.
//
// Run:
//   pnpm --filter @velto/database sync-system-roles
//   pnpm --filter @velto/database sync-system-roles -- --dry-run
//
// Against a production database (nothing is written without this):
//   NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1 pnpm --filter @velto/database sync-system-roles
import 'dotenv/config';
import { systemPrisma, withTenant } from './index';
import { SYSTEM_ROLES, PERMISSION_DEFS, permissionKeysForRole } from './rbac-catalog';

const DRY_RUN = process.argv.includes('--dry-run');

// Like backfill-permissions.ts, this one legitimately targets live tenants, so
// production is allowed — but only when asked for explicitly.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BACKFILL !== '1') {
  console.error(
    'Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_BACKFILL=1 once reviewed (try --dry-run first).',
  );
  process.exit(1);
}

const SYSTEM_ROLE_CODES = SYSTEM_ROLES.map((role) => role.code);

type Summary = { rolesCreated: number; linksCreated: number };

/**
 * Permission is global reference data (schema 6.2, not tenant-scoped) — one row
 * per "module.action" for the whole install, so this runs once, not per company.
 */
async function ensurePermissions(): Promise<{ idByKey: Map<string, string>; created: number }> {
  const existing = await systemPrisma.permission.findMany({ select: { id: true, module: true, code: true } });
  const idByKey = new Map(existing.map((p) => [`${p.module}.${p.code}`, p.id]));
  let created = 0;

  for (const def of PERMISSION_DEFS) {
    for (const action of def.actions) {
      const key = `${def.module}.${action}`;
      if (idByKey.has(key)) continue;

      console.log(`Permission row missing: ${key}`);
      created += 1;
      if (DRY_RUN) {
        // Stand-in id so the per-role counts below reflect what a real run
        // would grant, instead of reporting these as skipped.
        idByKey.set(key, `dry-run:${key}`);
        continue;
      }

      const permission = await systemPrisma.permission.upsert({
        where: { module_code: { module: def.module, code: action } },
        update: {},
        create: { module: def.module, code: action },
      });
      idByKey.set(key, permission.id);
    }
  }

  return { idByKey, created };
}

async function syncCompany(
  company: { id: string; name: string },
  permissionIdByKey: Map<string, string>,
): Promise<Summary> {
  // The whole per-tenant sync shares one `withTenant` transaction: `SET LOCAL
  // app.current_company_id` only lives for the current transaction, and a
  // partially-synced role (created but ungranted) would leave the tenant in a
  // state where the role is assignable but useless. Prisma's 5s interactive
  // default is tight for ~6 roles × up to 40 grants on a loaded box, hence the
  // wider window (same reason as seed.ts).
  return withTenant(
    company.id,
    async (tx) => {
      const summary: Summary = { rolesCreated: 0, linksCreated: 0 };

      // Matched on `code`, not on `isSystem`: role codes are what the app keys
      // off (users.service.ts, cash-sessions.service.ts) and MVP has no
      // custom-role authoring, so a catalog code always means the system role.
      const existing = await tx.role.findMany({
        where: { code: { in: SYSTEM_ROLE_CODES } },
        select: { id: true, code: true, isSystem: true },
      });
      // `null` marks a role a real run would create — only reachable under
      // --dry-run, and it makes the grant pass below still report the grants
      // that role would receive instead of silently under-counting them.
      const roleIdByCode = new Map<string, string | null>(existing.map((role) => [role.code, role.id]));

      for (const role of existing) {
        if (!role.isSystem) {
          console.warn(`  ! ${company.name}/${role.code}: existing row has isSystem=false — left as is`);
        }
      }

      for (const def of SYSTEM_ROLES) {
        if (roleIdByCode.has(def.code)) continue;

        console.log(`  ${company.name}: + role ${def.code} ("${def.name}")`);
        summary.rolesCreated += 1;
        if (DRY_RUN) {
          roleIdByCode.set(def.code, null);
          continue;
        }

        // Upsert rather than create: idempotent even against a concurrent run,
        // and `update: {}` keeps a tenant's existing display name intact
        // (renames are rename-system-roles.ts's job, not this script's).
        const role = await tx.role.upsert({
          where: { companyId_code: { companyId: company.id, code: def.code } },
          update: {},
          create: { companyId: company.id, code: def.code, name: def.name, isSystem: true },
          select: { id: true },
        });
        roleIdByCode.set(def.code, role.id);
      }

      for (const [code, roleId] of roleIdByCode) {
        const held = new Set(
          roleId === null
            ? []
            : (
                await tx.rolePermission.findMany({
                  where: { roleId },
                  select: { permissionId: true },
                })
              ).map((rp) => rp.permissionId),
        );

        const toAdd = permissionKeysForRole(code)
          .map((key) => ({ key, permissionId: permissionIdByKey.get(key) }))
          .filter((entry): entry is { key: string; permissionId: string } => {
            if (!entry.permissionId) {
              console.warn(`  ! ${company.name}/${code}: no Permission row for "${entry.key}" — skipped`);
              return false;
            }
            return !held.has(entry.permissionId);
          });

        if (toAdd.length === 0) continue;

        console.log(`  ${company.name}/${code}: +${toAdd.length} grant(s) (${toAdd.map((e) => e.key).join(', ')})`);
        if (DRY_RUN || roleId === null) {
          summary.linksCreated += toAdd.length;
          continue;
        }

        const result = await tx.rolePermission.createMany({
          data: toAdd.map((entry) => ({ roleId, permissionId: entry.permissionId })),
          skipDuplicates: true,
        });
        summary.linksCreated += result.count;
      }

      return summary;
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no writes will be performed.\n');

  const { idByKey, created: permissionsCreated } = await ensurePermissions();

  const companies = await systemPrisma.company.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  let rolesCreated = 0;
  let linksCreated = 0;
  for (const company of companies) {
    // Per company, so one tenant's failure (and its rollback) is visible and
    // doesn't take the others' work with it.
    const summary = await syncCompany(company, idByKey);
    rolesCreated += summary.rolesCreated;
    linksCreated += summary.linksCreated;
  }

  console.log('\n--- Summary ---');
  console.log(`Companies processed:        ${companies.length}`);
  console.log(`Permission rows created:    ${permissionsCreated}`);
  console.log(`Role rows created:          ${rolesCreated}`);
  console.log(`RolePermission links added: ${linksCreated}`);
  if (DRY_RUN) console.log('(dry run — nothing was written)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
