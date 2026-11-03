import type { TenantClient } from '@velto/database';
import type { AuditLogService } from '../../common/audit/audit-log.service';
import { auditRejection, type RejectionAuditEntry } from '../../common/audit/rejection-audit';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomerDeletedException } from './customers-exceptions';

/**
 * ADR-061a: the one guard for ledger writers that do not go through
 * lockActiveOrThrow (payments allocate/reverse, opening void). Caller MUST
 * already hold the Customer FOR UPDATE lock(s), so this read is fresh vs a
 * concurrent remove()/restore(). A hit is audited (own tx, after rollback) and
 * throws before any ledger row is written.
 */
export async function assertCustomersNotDeleted(
  tx: TenantClient,
  customerIds: string[],
  audit: { tenantPrisma: TenantPrismaService; auditLog: AuditLogService; entry: RejectionAuditEntry },
): Promise<void> {
  if (customerIds.length === 0) return;
  const deleted = await tx.customer.findMany({
    where: { id: { in: customerIds }, deletedAt: { not: null } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (deleted.length === 0) return;
  throw auditRejection(audit.tenantPrisma, audit.auditLog, audit.entry, new CustomerDeletedException(deleted.map((c) => c.id)));
}
