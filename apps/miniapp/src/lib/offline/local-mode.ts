/**
 * Offline Unlock "local mode" (ADR-071): the session was opened with the offline passphrase while the
 * network/server could not vouch for the user. In this mode NO request leaves the device (apiFetch and the
 * token refresh throw before any fetch), sync is paused, and documents are only queued as PENDING under the
 * entry owner. Leaving the mode is an explicit, user-triggered reconnect that must re-prove the owner online.
 * No imports on purpose (client.ts and session.ts depend on it).
 */
export interface LocalOwner {
  userId: string;
  companyId: string;
}

export class LocalModeNetworkError extends Error {
  readonly code = 'LOCAL_MODE_NO_NETWORK';
  constructor() {
    super('Offline unlock mode: network access is disabled');
    this.name = 'LocalModeNetworkError';
  }
}

let owner: LocalOwner | null = null;
const listeners = new Set<() => void>();

export function enterLocalMode(o: LocalOwner): void {
  owner = { userId: o.userId, companyId: o.companyId };
  for (const l of [...listeners]) l();
}
export function leaveLocalMode(): void {
  if (!owner) return;
  owner = null;
  for (const l of [...listeners]) l();
}
export function isLocalMode(): boolean {
  return owner !== null;
}
export function getLocalOwner(): LocalOwner | null {
  return owner;
}
let probing = false;
const PROBE_PATHS = ['/auth/me', '/auth/refresh'];

/** Local mode stays ON; only the owner-verification calls (/auth/me, /auth/refresh) may pass while a reconnect probe runs. */
export async function withVerificationProbe<T>(fn: () => Promise<T>): Promise<T> {
  probing = true;
  try {
    return await fn();
  } finally {
    probing = false;
  }
}

export function assertNetworkAllowed(path?: string): void {
  if (!owner) return;
  if (probing && path !== undefined && PROBE_PATHS.some((p) => path === p || path.startsWith(p + '?'))) return;
  throw new LocalModeNetworkError();
}
export function subscribeLocalMode(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
