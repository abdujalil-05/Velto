import { Injectable } from '@nestjs/common';
import type { Prisma, TenantClient } from '@velto/database';

export interface AuditLogEntry {
  companyId: string;
  userId?: string;
  action: string; // e.g. "product.create"
  entity: string; // e.g. "Product"
  entityId: string;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
  ip?: string;
}

/**
 * Prisma rows often carry Date/Decimal values that aren't directly assignable
 * to Prisma.InputJsonValue. Both have `toJSON()` (Decimal -> string, Date ->
 * ISO string), so a round-trip through JSON gives a safe, storable snapshot.
 */
export function toAuditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** SEC-050..054: every write is audited (append-only, enforced by a DB trigger — see prisma/migrations/*_rls_and_audit_lock). */
@Injectable()
export class AuditLogService {
  async log(tx: TenantClient, entry: AuditLogEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        companyId: entry.companyId,
        userId: entry.userId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        ip: entry.ip,
      },
    });
  }
}
