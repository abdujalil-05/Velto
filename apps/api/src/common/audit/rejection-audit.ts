import type { AppException } from '../errors/app-exception';
import { TenantContext } from '../tenant/tenant-context';
import type { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { toAuditJson, type AuditLogEntry, type AuditLogService } from './audit-log.service';

export type RejectionAuditEntry = Pick<AuditLogEntry, 'companyId' | 'userId' | 'action' | 'entity' | 'entityId'>;

/**
 * ADR-061: a business rejection inside the tenant tx is rolled back with it, so
 * its `<action>_rejected` audit row is written in its OWN tx strictly after the
 * rollback (TenantContext.afterRollback; no nested tx, no held locks). Details
 * must be PII-free (codes/counts/amounts only). Returns `err` for `throw`.
 */
export function auditRejection<E extends AppException>(
  tenantPrisma: TenantPrismaService,
  auditLog: AuditLogService,
  entry: RejectionAuditEntry,
  err: E,
): E {
  const { code, details } = err.getResponse() as { code: string; details?: unknown };
  TenantContext.afterRollback(() =>
    tenantPrisma.run(entry.companyId, (tx) =>
      auditLog.log(tx, {
        ...entry,
        action: `${entry.action}_rejected`,
        newValue: toAuditJson({ reason: code, ...(details !== undefined ? { details } : {}) }),
      }),
    ),
  );
  return err;
}
