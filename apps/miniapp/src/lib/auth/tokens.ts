// Local-storage token pair. There's no server-side session (the API is a
// separate NestJS service, 11.2), so the auth guard in the (app) layout is
// client-side: it checks these on mount and redirects if absent.
const ACCESS_TOKEN_KEY = 'velto.accessToken';
const REFRESH_TOKEN_KEY = 'velto.refreshToken';

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string): void {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export interface TokenOwner {
  userId: string;
  companyId: string;
}

/** Thrown (before any network I/O) when the bearer token belongs to someone other than the document/vault owner. */
export class TokenOwnerMismatchError extends Error {
  readonly code = 'TOKEN_OWNER_MISMATCH';
  constructor() {
    super('Access token belongs to a different user than the offline session');
    this.name = 'TokenOwnerMismatchError';
  }
}

/** Local, unverified read of the JWT claims (sub, companyId). Only a client-side owner guard; the server verifies the signature. */
export function decodeTokenOwner(token: string | null): TokenOwner | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const c = JSON.parse(json) as { sub?: unknown; companyId?: unknown };
    return typeof c.sub === 'string' && typeof c.companyId === 'string' ? { userId: c.sub, companyId: c.companyId } : null;
  } catch {
    return null;
  }
}

/** True when a token exists and its claims are not exactly `owner` (an undecodable token counts as foreign). Missing token = not foreign (plain 401 path). */
export function tokenIsForeign(token: string | null, owner: TokenOwner): boolean {
  if (!token) return false;
  const o = decodeTokenOwner(token);
  return !o || o.userId !== owner.userId || o.companyId !== owner.companyId;
}
