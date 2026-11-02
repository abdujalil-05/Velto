import type { TenantClient } from '@velto/database';

/**
 * True while the access token's session (`sid` = refresh-token familyId) still has a live refresh token.
 * Logout / logout-all / password reset revoke those rows, so a stolen access token stops working here
 * instead of only at its 15-minute expiry. Must run inside a tenant tx (RLS).
 */
export async function isSessionActive(tx: TenantClient, userId: string, sid: string | undefined): Promise<boolean> {
  if (!sid) return false;
  const row = await tx.refreshToken.findFirst({
    where: { familyId: sid, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return row !== null;
}
