import type { AuthenticatedUser } from '../auth/auth.types';
import { ClientIdConflictException } from '../errors/client-id-conflict.exception';

/**
 * TZ §11.2 object ownership for clientId dedup: an existing document is an
 * idempotent replay only for the user who created it. SALES_AGENT is the
 * ownership-scoped role (sees only own docs); company-wide office roles already
 * read every document, and may create on an agent's behalf (creator column =
 * delegated agent), so only the cross-tenant-agent leak is closed for them.
 * `strict` = always require the exact creator (no delegation, e.g. receipts).
 */
export function assertClientIdReplayAllowed(
  creatorId: string | null | undefined,
  user: AuthenticatedUser,
  strict = false,
): void {
  if (creatorId === user.id) return;
  if (!strict && !user.roles.includes('SALES_AGENT')) return;
  throw new ClientIdConflictException();
}
