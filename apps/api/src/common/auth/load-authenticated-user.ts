import type { TenantClient } from '@velto/database';
import type { AuthenticatedUser } from './auth.types';

/** AuthenticatedUser plus the id of the user's CONFIRMED UserMfa (null if none) — read in the same query, for ADR-058 session checks. */
export type LoadedAuthenticatedUser = AuthenticatedUser & { confirmedMfaId: string | null };

/**
 * Re-reads a user's active flag, roles and permissions by PK inside the
 * caller's tenant tx (never trusting the JWT). Returns null when the user is
 * missing or deactivated, or its company is deactivated. Same shape TenantContextInterceptor hydrates.
 */
export async function loadAuthenticatedUser(tx: TenantClient, userId: string, companyId: string): Promise<LoadedAuthenticatedUser | null> {
  // Same rule as TenantContextInterceptor: a deactivated company is treated like a deactivated user (401).
  const user = await tx.user.findFirst({
    where: { id: userId, company: { isActive: true } },
    include: { mfa: { select: { id: true, confirmedAt: true } } },
  });
  if (!user || !user.isActive) return null;
  const userRoles = await tx.userRole.findMany({
    where: { userId: user.id },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  return {
    id: user.id,
    companyId,
    firstName: user.firstName,
    lastName: user.lastName,
    confirmedMfaId: user.mfa?.confirmedAt ? user.mfa.id : null,
    roles: userRoles.map((ur) => ur.role.code),
    permissions: [...new Set(userRoles.flatMap((ur) => ur.role.permissions.map((rp) => `${rp.permission.module}.${rp.permission.code}`)))],
  };
}
