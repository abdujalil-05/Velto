import { Prisma } from '@velto/database';
import { TenantContext } from '../tenant/tenant-context';

/** ADR-045: per-company xact advisory lock serialising company-export creation so the "<=1 active" check cannot be raced. Released at COMMIT/ROLLBACK. */
export async function lockCompanyExportExclusive(): Promise<void> {
  const { tx, companyId } = TenantContext.current;
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('velto.company_export'), hashtext(${companyId}))`);
}
