// ADR-058 follow-up: shared helpers for the one-time out-of-band MFA
// enrollment code (platform script, bootstrap-owner and the API all use these
// so the format/hash never drift apart).
import crypto from 'node:crypto';
import type { TenantClient } from './client';

/** Crockford base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const MFA_ENROLLMENT_CODE_LENGTH = 12;
// PO decision: 1h (was 72h). Applied at issuance only; codes already issued keep
// their stored expiresAt, which redemption checks (no data migration).
export const MFA_ENROLLMENT_CODE_TTL_MS = 60 * 60 * 1000;
export const MFA_ENROLLMENT_CODE_ISSUED_AUDIT_ACTION = 'auth.mfa.enrollment_code_issued';

/** 12 Crockford-base32 chars (60 bits) from crypto.randomBytes; 256 % 32 === 0, so no modulo bias. */
export function generateMfaEnrollmentCode(): string {
  const bytes = crypto.randomBytes(MFA_ENROLLMENT_CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out;
}

/**
 * Canonical form before hashing: uppercase, separators/whitespace stripped,
 * Crockford aliases folded (O→0, I/L→1). Lets users type it loosely.
 */
export function normalizeMfaEnrollmentCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** sha256 hex of the normalized code — the only form ever stored. */
export function hashMfaEnrollmentCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeMfaEnrollmentCode(code), 'utf8').digest('hex');
}

export type IssueMfaEnrollmentCodeResult = {
  code: string;
  enrollmentCodeId: string;
  expiresAt: Date;
  invalidated: number;
  /** null when the caller opted out via skipAudit and writes its own audit row. */
  auditLogId: string | null;
};

/**
 * Issues a code inside an already-open tenant transaction (reused by
 * bootstrap-owner.ts). createdById null = platform actor.
 */
export async function issueMfaEnrollmentCodeInTx(
  tx: TenantClient,
  input: { companyId: string; userId: string; createdById?: string | null; auditNewValue?: Record<string, string>; skipAudit?: boolean },
): Promise<IssueMfaEnrollmentCodeResult> {
  const { companyId, userId } = input;
  const createdById = input.createdById ?? null;
  const now = new Date();
  const invalidated = await tx.mfaEnrollmentCode.updateMany({
    where: { companyId, userId, usedAt: null },
    data: { usedAt: now },
  });
  const code = generateMfaEnrollmentCode();
  const expiresAt = new Date(now.getTime() + MFA_ENROLLMENT_CODE_TTL_MS);
  const row = await tx.mfaEnrollmentCode.create({
    data: { companyId, userId, codeHash: hashMfaEnrollmentCode(code), expiresAt, createdById },
    select: { id: true },
  });
  if (input.skipAudit) {
    return { code, enrollmentCodeId: row.id, expiresAt, invalidated: invalidated.count, auditLogId: null };
  }
  const audit = await tx.auditLog.create({
    data: {
      companyId,
      userId: createdById,
      action: MFA_ENROLLMENT_CODE_ISSUED_AUDIT_ACTION,
      entity: 'User',
      entityId: userId,
      // Never the code or its hash.
      newValue: {
        enrollmentCodeId: row.id,
        expiresAt: expiresAt.toISOString(),
        invalidatedPrevious: invalidated.count,
        ...(createdById ? {} : { actor: 'platform' }),
        ...input.auditNewValue,
      },
    },
    select: { id: true },
  });
  return { code, enrollmentCodeId: row.id, expiresAt, invalidated: invalidated.count, auditLogId: audit.id };
}
