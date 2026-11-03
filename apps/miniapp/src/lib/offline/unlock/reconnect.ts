import type { AuthenticatedUser } from '@/lib/api/types';
import { resumeSession, type ResumeResult } from '@/lib/auth/auth-flow';
import { getLocalOwner, leaveLocalMode, withVerificationProbe } from '../local-mode';
import { setSyncPaused } from '../session';
import { lockVault } from '../vault';

export type ReconnectResult =
  | { kind: 'ok'; user: AuthenticatedUser }
  /** The server authenticated someone else than the local-mode owner: the owner's UK is locked, nothing is pushed for them. */
  | { kind: 'mismatch'; user: AuthenticatedUser }
  | { kind: 'still-offline' }
  | { kind: 'rejected' }
  | { kind: 'mfa-web-required' };

/**
 * Leaves local mode ONLY through a fresh online /auth/me whose id+companyId equal the local owner (ADR-071).
 * Sync stays paused until the caller flips the status to 'authenticated'; a network failure re-enters local mode.
 */
export async function reconnectFromLocal(resume: () => Promise<ResumeResult> = resumeSession): Promise<ReconnectResult> {
  const owner = getLocalOwner();
  if (!owner) return { kind: 'still-offline' };
  // Local mode stays ON during the probe: only /auth/me and /auth/refresh may reach the network, sync stays paused.
  let res: ResumeResult;
  try {
    res = await withVerificationProbe(resume);
  } catch {
    res = { kind: 'offline' };
  }
  if (res.kind === 'ok') {
    if (res.user.id !== owner.userId || res.user.companyId !== owner.companyId) {
      leaveLocalMode();
      lockVault();
      return { kind: 'mismatch', user: res.user };
    }
    leaveLocalMode(); // only now: /auth/me ok AND owner match
    setSyncPaused(false);
    return { kind: 'ok', user: res.user };
  }
  if (res.kind === 'offline') return { kind: 'still-offline' };
  leaveLocalMode();
  lockVault();
  return res.kind === 'mfa-web-required' ? { kind: 'mfa-web-required' } : { kind: 'rejected' };
}
