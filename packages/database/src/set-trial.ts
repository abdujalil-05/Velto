// ADR-040: set/clear a tenant's trial end date (platform-admin, DB-level only in MVP).
// Cross-tenant by definition -> `systemPrisma` (velto_system, BYPASSRLS); the Tenant row is
// addressed by slug and every audit row is scoped to each of the tenant's companies.
//
// Usage:
//   pnpm --filter @velto/database exec tsx src/set-trial.ts <tenantSlug> <ISO-date|none> [--dry-run]
// Production (nothing is written without the explicit flag):
//   NODE_ENV=production ALLOW_PRODUCTION_SET_TRIAL=1 pnpm --filter @velto/database exec tsx src/set-trial.ts <slug> <ISO-date|none>
import 'dotenv/config';
import { systemPrisma } from './index';

const DRY_RUN = process.argv.includes('--dry-run');
const [slug, rawDate] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SET_TRIAL !== '1') {
  console.error('Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_SET_TRIAL=1 once reviewed (try --dry-run first).');
  process.exit(1);
}
if (!slug || !rawDate) {
  console.error('Usage: tsx src/set-trial.ts <tenantSlug> <ISO-date|none> [--dry-run]');
  process.exit(1);
}
const trialEndsAt = rawDate === 'none' ? null : new Date(rawDate);
if (trialEndsAt && Number.isNaN(trialEndsAt.getTime())) {
  console.error(`Invalid date: ${rawDate}`);
  process.exit(1);
}

async function main() {
  const tenant = await systemPrisma.tenant.findUnique({
    where: { slug: slug! },
    select: { id: true, trialEndsAt: true, companies: { select: { id: true } } },
  });
  if (!tenant) {
    console.error(`Tenant not found: ${slug}`);
    process.exit(1);
  }
  const from = tenant.trialEndsAt?.toISOString() ?? null;
  const to = trialEndsAt?.toISOString() ?? null;
  console.log(`${DRY_RUN ? '[dry-run] would set' : 'setting'} trialEndsAt ${from} -> ${to} for tenant ${slug}`);
  if (DRY_RUN) return;

  await systemPrisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenant.id }, data: { trialEndsAt } });
    for (const c of tenant.companies) {
      await tx.auditLog.create({
        data: {
          companyId: c.id,
          userId: null,
          action: 'tenant.trial.set',
          entity: 'Tenant',
          entityId: tenant.id,
          oldValue: { trialEndsAt: from },
          newValue: { trialEndsAt: to },
        },
      });
    }
  });
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
