import { Prisma } from '@velto/database';
import { TenantContext } from '../tenant/tenant-context';

/**
 * ADR-025: a per-company transaction-scoped advisory lock serialising 1C
 * export creation against ledger changes that would alter an exported period
 * (payments.reverse). Export create() takes it EXCLUSIVE before inserting the
 * ExportJob; reverse() takes it SHARED as its very first lock, so reversals
 * never wait for each other, only for an in-flight export create (and vice
 * versa). Released automatically at COMMIT/ROLLBACK of TenantContext's tx.
 *
 * Lock order: advisory(export1c) -> payment -> customer -> invoices. Export
 * create() holds no row lock before it, so no cycle is possible.
 *
 * Correctness relies on READ COMMITTED (withTenant default): each statement
 * after the lock is acquired sees what the other side committed.
 */
const lockKey = (companyId: string) => Prisma.sql`hashtext('velto.export1c'), hashtext(${companyId})`;

export async function lockExport1cExclusive(): Promise<void> {
  const { tx, companyId } = TenantContext.current;
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${lockKey(companyId)})`);
}

export async function lockExport1cShared(): Promise<void> {
  const { tx, companyId } = TenantContext.current;
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock_shared(${lockKey(companyId)})`);
}
