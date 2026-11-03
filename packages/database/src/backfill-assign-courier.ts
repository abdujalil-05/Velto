// One-off, idempotent data fix (PO decisions, 2026-11): order hand-off got
// granular permissions split from `orders.update`:
//   - `orders.assignCourier`     -> OWNER (ALL), SALES_DIRECTOR, WAREHOUSE
//   - `orders.dispatch`          -> OWNER (ALL), WAREHOUSE  (CONFIRMED -> SHIPPED)
//   - `orders.returnToWarehouse` -> OWNER (ALL), SALES_DIRECTOR, WAREHOUSE (SHIPPED -> CONFIRMED)
// plus `orders.cancel` for SALES_DIRECTOR and WAREHOUSE losing `orders.update`.
// seed.ts / bootstrap-owner.ts only reach fresh databases and
// backfill-permissions.ts is purely additive (never revokes), so tenants that
// were already provisioned need this script.
//
// Scope is data-driven (NEW_PERMISSION_GRANTS / EXTRA_GRANTS / REVOCATIONS
// below) and cross-checked against the catalog at run time: every new key must
// be held by exactly the listed system roles. `--apply` performs only: ensure
// the new Permission rows, add the listed grants, revoke WAREHOUSE ->
// orders.update. Any other difference between a system role's grants and the
// catalog is a DIVERGENCE: reported, never modified (no-overwrite policy for
// manual or unknown grants). Each company's writes run in one transaction
// (under a per-company advisory lock) together with an append-only AuditLog
// row. Second run = 0 changes.
//
// Cross-tenant by definition -> `systemPrisma` (velto_system, BYPASSRLS,
// DATABASE_SYSTEM_URL), same as backfill-permissions.ts; every query is still
// scoped by companyId / roleId.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/backfill-assign-courier.ts            (dry run, default)
//   pnpm --filter @velto/database exec tsx src/backfill-assign-courier.ts --apply
//   ... --company=<uuid> [--company=<uuid>]
// Production (nothing is written without the explicit flag):
//   NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1 pnpm --filter @velto/database exec tsx src/backfill-assign-courier.ts --apply
import 'dotenv/config';
import { systemPrisma, type TenantClient } from './index';
import { ensurePermissions } from './backfill-permissions';
import { ROLE_PERMISSIONS, permissionKeysForRole } from './rbac-catalog';

type Db = TenantClient;
type Grant = { role: string; key: string };

/** New permission keys -> the exact system roles that must hold them (catalog-checked). */
export const NEW_PERMISSION_GRANTS: Readonly<Record<string, readonly string[]>> = {
  'orders.assignCourier': ['OWNER', 'SALES_DIRECTOR', 'WAREHOUSE'],
  'orders.dispatch': ['OWNER', 'WAREHOUSE'],
  'orders.returnToWarehouse': ['OWNER', 'SALES_DIRECTOR', 'WAREHOUSE'],
};
/** Grants of pre-existing keys added by the same PO decision. */
export const EXTRA_GRANTS: readonly Grant[] = [{ role: 'SALES_DIRECTOR', key: 'orders.cancel' }];
export const REVOCATIONS: readonly Grant[] = [{ role: 'WAREHOUSE', key: 'orders.update' }];

export const NEW_PERMISSIONS: readonly string[] = Object.keys(NEW_PERMISSION_GRANTS);
export const CHANGES: { add: Grant[]; revoke: Grant[] } = {
  add: [
    ...EXTRA_GRANTS,
    ...Object.entries(NEW_PERMISSION_GRANTS).flatMap(([key, roles]) => roles.map((role) => ({ role, key }))),
  ],
  revoke: [...REVOCATIONS],
};

const SYSTEM_ROLE_CODES = Object.keys(ROLE_PERMISSIONS);
const fmt = (g: Grant) => `${g.role}:${g.key}`;

/** Refuses to run if the catalog no longer agrees with the declared change set. */
export function assertCatalogMatchesChanges(): void {
  for (const g of CHANGES.add) {
    if (!permissionKeysForRole(g.role).includes(g.key)) throw new Error(`rbac-catalog.ts does not grant ${fmt(g)} — refusing.`);
  }
  for (const g of CHANGES.revoke) {
    if (permissionKeysForRole(g.role).includes(g.key)) throw new Error(`rbac-catalog.ts still grants ${fmt(g)} — refusing.`);
  }
  for (const [key, roles] of Object.entries(NEW_PERMISSION_GRANTS)) {
    const holders = SYSTEM_ROLE_CODES.filter((code) => permissionKeysForRole(code).includes(key)).sort();
    if (holders.join(',') !== [...roles].sort().join(',')) {
      throw new Error(`rbac-catalog.ts grants ${key} to [${holders.join(', ')}], expected [${[...roles].sort().join(', ')}] — refusing.`);
    }
  }
}

export type CompanyReport = {
  companyId: string;
  name: string;
  toAdd: Grant[];
  toRevoke: Grant[];
  /** Catalog grants still missing after this script (other scripts' scope). */
  missing: Grant[];
  /** Grants held beyond the catalog (manual/unknown) — never touched. */
  extra: Grant[];
};
export type AssignCourierResult = {
  dryRun: boolean;
  permissionsCreated: number;
  grantsAdded: number;
  grantsRevoked: number;
  companies: CompanyReport[];
};
export type AssignCourierOptions = {
  dryRun: boolean;
  companyIds?: string[];
  /** Per-company transaction. Defaults to running directly on `db` (tests pass a rolled-back tx). */
  transact?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
};

async function planCompany(db: Db, company: { id: string; name: string }) {
  const roles = await db.role.findMany({
    where: { companyId: company.id, code: { in: SYSTEM_ROLE_CODES } },
    select: { id: true, code: true, companyId: true, permissions: { select: { permission: { select: { module: true, code: true } } } } },
  });
  const report: CompanyReport = { companyId: company.id, name: company.name, toAdd: [], toRevoke: [], missing: [], extra: [] };
  const roleIdByCode = new Map<string, string>();

  for (const role of roles) {
    if (role.companyId !== company.id) throw new Error(`Role ${role.id} is not owned by company ${company.id}`);
    roleIdByCode.set(role.code, role.id);
    const held = new Set(role.permissions.map((rp) => `${rp.permission.module}.${rp.permission.code}`));

    for (const g of CHANGES.add) if (g.role === role.code && !held.has(g.key)) report.toAdd.push(g);
    for (const g of CHANGES.revoke) if (g.role === role.code && held.has(g.key)) report.toRevoke.push(g);

    const after = new Set(held);
    for (const g of report.toAdd) if (g.role === role.code) after.add(g.key);
    for (const g of report.toRevoke) if (g.role === role.code) after.delete(g.key);
    const expected = new Set(permissionKeysForRole(role.code));
    for (const key of expected) if (!after.has(key)) report.missing.push({ role: role.code, key });
    for (const key of after) if (!expected.has(key)) report.extra.push({ role: role.code, key });
  }
  return { report, roleIdByCode };
}

export async function backfillAssignCourier(db: Db, opts: AssignCourierOptions): Promise<AssignCourierResult> {
  assertCatalogMatchesChanges();
  const { dryRun } = opts;
  const transact = opts.transact ?? (<T>(fn: (tx: Db) => Promise<T>) => fn(db));

  const { idByKey, created } = await ensurePermissions(db, dryRun, NEW_PERMISSIONS);
  const companies = await db.company.findMany({
    where: opts.companyIds ? { id: { in: opts.companyIds } } : undefined,
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  const result: AssignCourierResult = { dryRun, permissionsCreated: created, grantsAdded: 0, grantsRevoked: 0, companies: [] };
  for (const company of companies) {
    if (dryRun) {
      const { report } = await planCompany(db, company);
      result.grantsAdded += report.toAdd.length;
      result.grantsRevoked += report.toRevoke.length;
      result.companies.push(report);
      continue;
    }
    // Re-plan inside the transaction so the writes match what is committed.
    const report = await transact(async (tx) => {
      // Per-company xact lock: concurrent runs serialize, the loser re-plans to a no-op (no double audit).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`backfill-assign-courier:${company.id}`}))`;
      const { report, roleIdByCode } = await planCompany(tx, company);
      if (report.toAdd.length === 0 && report.toRevoke.length === 0) return report;
      const link = (g: Grant) => {
        const permissionId = idByKey.get(g.key);
        if (!permissionId) throw new Error(`No Permission row for "${g.key}"`);
        return { roleId: roleIdByCode.get(g.role)!, permissionId };
      };
      const added = await tx.rolePermission.createMany({ data: report.toAdd.map(link), skipDuplicates: true });
      let revoked = 0;
      for (const g of report.toRevoke) revoked += (await tx.rolePermission.deleteMany({ where: link(g) })).count;
      await tx.auditLog.create({
        data: {
          companyId: company.id,
          userId: null,
          action: 'role.permission.sync',
          entity: 'Company',
          entityId: company.id,
          oldValue: { revoked: report.toRevoke.map(fmt) },
          newValue: { granted: report.toAdd.map(fmt), reason: `PO 2026-11: ${NEW_PERMISSIONS.join(', ')} split from orders.update` },
        },
      });
      result.grantsAdded += added.count;
      result.grantsRevoked += revoked;
      return report;
    });
    result.companies.push(report);
  }
  return result;
}

export function printReport(result: AssignCourierResult): void {
  const tag = result.dryRun ? '[dry-run] ' : '';
  for (const c of result.companies) {
    console.log(`${c.name} (${c.companyId})`);
    console.log(`  ${tag}grant:  ${c.toAdd.length ? c.toAdd.map(fmt).join(', ') : '-'}`);
    console.log(`  ${tag}revoke: ${c.toRevoke.length ? c.toRevoke.map(fmt).join(', ') : '-'}`);
    if (c.missing.length) console.log(`  DIVERGENCE missing (not modified): ${c.missing.map(fmt).join(', ')}`);
    if (c.extra.length) console.log(`  DIVERGENCE extra (not modified): ${c.extra.map(fmt).join(', ')}`);
  }
  const divergent = result.companies.filter((c) => c.missing.length || c.extra.length).length;
  console.log('\n--- Summary ---');
  console.log(`Companies: ${result.companies.length}, divergent: ${divergent}`);
  console.log(`${tag}Permission rows created: ${result.permissionsCreated}`);
  console.log(`${tag}Grants added: ${result.grantsAdded}, revoked: ${result.grantsRevoked}`);
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BACKFILL !== '1') {
    throw new Error('Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_BACKFILL=1 once reviewed (dry run first).');
  }
  const apply = process.argv.includes('--apply');
  const companyArgs = process.argv.filter((a) => a.startsWith('--company=')).map((a) => a.slice('--company='.length));
  const result = await backfillAssignCourier(systemPrisma, {
    dryRun: !apply,
    companyIds: companyArgs.length > 0 ? companyArgs : undefined,
    transact: (fn) => systemPrisma.$transaction(fn),
  });
  printReport(result);
  if (!apply) console.log('(dry run — nothing was written; pass --apply to write)');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
