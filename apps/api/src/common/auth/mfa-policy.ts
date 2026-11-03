import { MFA_REQUIRED_ROLE_CODES } from '@velto/database';

const REQUIRED = new Set<string>(MFA_REQUIRED_ROLE_CODES);

/** ADR-058: does this role set (the user's CURRENT roles) have to be backed by TOTP MFA? */
export function requiresMfa(roleCodes: readonly string[]): boolean {
  return roleCodes.some((code) => REQUIRED.has(code));
}

/**
 * A session of a privileged user is valid only while its `mfa` claim equals the
 * user's current CONFIRMED UserMfa id. Covers role elevation (no claim), MFA
 * reset (no confirmed row) and re-enrollment (new id). Non-privileged: always valid.
 */
export function isMfaSessionValid(roleCodes: readonly string[], confirmedMfaId: string | null, tokenMfaId: string | null | undefined): boolean {
  if (!requiresMfa(roleCodes)) return true;
  return confirmedMfaId !== null && tokenMfaId === confirmedMfaId;
}
