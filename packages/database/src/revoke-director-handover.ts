// One-off data fix (ADR-029, F8.1): `payments.handover` was briefly granted to
// SALES_DIRECTOR in rbac-catalog.ts. Decision: only OWNER and CASHIER accept /
// reject agent handovers (SALES_DIRECTOR has no `cash.open`, so cannot run a
// cash session — segregation of duties). backfill-permissions.ts is purely
// additive and never takes a grant away, so tenants provisioned while the
// grant existed keep it; this script removes exactly that one link and
// nothing else.
//
// Scope is hard-coded: role code SALES_DIRECTOR x permission payments.handover.
// Idempotent (no-op once removed / on a DB that never had it). Each removal is
// paired with an append-only AuditLog row in the same transaction, so the
// revocation is traceable per tenant.
//
// Cross-tenant by definition -> `systemPrisma` (velto_system, BYPASSRLS), every
// query still explicitly scoped by companyId / roleId.
//
// Run:
//   pnpm --filter @velto/database exec tsx src/revoke-director-handover.ts --dry-run
//   pnpm --filter @velto/database exec tsx src/revoke-director-handover.ts
// Production (nothing is written without the explicit flag):
//   NODE_ENV=production ALLOW_PRODUCTION_REVOKE=1 pnpm --filter @velto/database exec tsx src/revoke-director-handover.ts
import 'dotenv/config';
import { systemPrisma } from './index';
import { permissionKeysForRole } from './rbac-catalog';

const DRY_RUN = process.argv.includes('--dry-run');
const ROLE_CODE = 'SALES_DIRECTOR';
const PERMISSION = { module: 'payments', code: 'handover' } as const;
const PERMISSION_KEY = `${PERMISSION.module}.${PERMISSION.code}`;

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_REVOKE !== '1') {
  console.error('Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_REVOKE=1 once reviewed (try --dry-run first).');
  process.exit(1);
}

// Guard against running this after the catalog re-grants the permission.
if (permissionKeysForRole(ROLE_CODE).includes(PERMISSION_KEY)) {
  console.error(`Refusing to run: rbac-catalog.ts still grants ${PERMISSION_KEY} to ${ROLE_CODE}.`);
  process.exit(1);
}

async function main() {
  const permission = await systemPrisma.permission.findFirst({ where: PERMISSION, select: { id: true } });
  if (!permission) {
    console.log(`No Permission row for ${PERMISSION_KEY} — nothing to revoke.`);
    return;
  }

  const links = await systemPrisma.rolePermission.findMany({
    where: { permissionId: permission.id, role: { code: ROLE_CODE } },
    select: { roleId: true, role: { select: { companyId: true } } },
  });

  let revoked = 0;
  for (const link of links) {
    const { roleId } = link;
    const companyId = link.role.companyId;
    console.log(`${DRY_RUN ? '[dry-run] would revoke' : 'revoking'} ${PERMISSION_KEY} from ${ROLE_CODE} role ${roleId} (company ${companyId})`);
    if (DRY_RUN) continue;

    await systemPrisma.$transaction(async (tx) => {
      const res = await tx.rolePermission.deleteMany({ where: { roleId, permissionId: permission.id } });
      if (res.count === 0) return;
      await tx.auditLog.create({
        data: {
          companyId,
          userId: null,
          action: 'role.permission.revoke',
          entity: 'Role',
          entityId: roleId,
          oldValue: { roleCode: ROLE_CODE, permission: PERMISSION_KEY, granted: true },
          newValue: { roleCode: ROLE_CODE, permission: PERMISSION_KEY, granted: false, reason: 'ADR-029: OWNER + CASHIER only' },
        },
      });
      revoked += res.count;
    });
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${links.length} link(s) found, ${revoked} revoked.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
