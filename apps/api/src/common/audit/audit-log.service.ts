import { Injectable } from '@nestjs/common';
import { getTraceId } from '../trace/trace-context';
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

const REDACTED = '***';

/** Exact (lowercased) keys exempt from the deny-list: truncated initData hash prefix is a non-secret audit marker. */
const NON_SENSITIVE_KEYS = new Set(['initdatahashprefix']);

/** §11.4 deny-list, case-insensitive: *password*, *token*, *otp*, *secret*, initData, *hash*, apikey, authorization, cookie, pin. */
function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  if (NON_SENSITIVE_KEYS.has(k)) return false;
  return (
    k.includes('password') ||
    k.includes('token') ||
    k.includes('otp') ||
    k.includes('secret') ||
    k === 'initdata' ||
    k.includes('hash') ||
    k.includes('apikey') ||
    k.includes('api_key') ||
    k.includes('authorization') ||
    k.includes('cookie') ||
    k === 'pin'
  );
}

/** Recursively replaces values of sensitive keys with '***' (objects and arrays). Pure; input untouched. */
export function redactAuditJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactAuditJson(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactAuditJson(v);
    }
    return out as T;
  }
  return value;
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
        oldValue: redactAuditJson(entry.oldValue),
        newValue: redactAuditJson(entry.newValue),
        ip: entry.ip,
        traceId: getTraceId() ?? null,
      },
    });
  }
}
