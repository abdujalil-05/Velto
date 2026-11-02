/**
 * The identity the offline layer acts for. Set synchronously by
 * auth-context.tsx the moment /auth/me resolves (and cleared on logout /
 * forced sign-out). The queue stamps every document with it and the sync
 * engine pushes ONLY documents carrying the same pair, so a document is never
 * sent under another user's token (TZ 8.4 "User/agent vakolati").
 */
export interface OfflineSession {
  userId: string;
  companyId: string;
}

let current: OfflineSession | null = null;

const OWNER_STORAGE_KEY = 'velto.sessionOwner';

let syncPaused = false;
/** Logout stops background push/resolution first; a new session (sign-in) re-enables it. */
export function isSyncPaused(): boolean {
  return syncPaused;
}
export function setSyncPaused(paused: boolean): void {
  syncPaused = paused;
}

let syncAbort = new AbortController();
/** Signal for every network call made by push/resolution; logout / session end aborts it (apiFetch forwards `signal` to fetch). */
export function getSyncSignal(): AbortSignal {
  return syncAbort.signal;
}
/** Aborts requests started so far; later ones get a fresh signal. */
export function abortSyncRequests(): void {
  syncAbort.abort();
  syncAbort = new AbortController();
}

export function setOfflineSession(session: OfflineSession | null): void {
  current = session;
  if (session) syncPaused = false;
  // Survives an app restart so a revoke detected at bootstrap (no in-memory
  // session yet) still knows whose documents to quarantine. Ids only, no data.
  if (session) {
    try {
      window.localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* storage unavailable: revoke falls back to the in-memory session */
    }
  }
}

/** In-memory session, else the owner persisted by the last successful sign-in on this device. */
export function getLastKnownOwner(): OfflineSession | null {
  if (current) return current;
  try {
    const raw = window.localStorage.getItem(OWNER_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<OfflineSession>) : null;
    return v?.userId && v.companyId ? { userId: v.userId, companyId: v.companyId } : null;
  } catch {
    return null;
  }
}

const OWNER_TG_KEY = 'velto.sessionOwnerTelegramId';

/** Telegram user id the server verified (initData) at the last /auth/telegram sign-in on this device. Only a client-side hint for gating the revoked-export button, not a security guarantee. */
export function setOwnerTelegramId(id: number | string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(OWNER_TG_KEY);
    else window.localStorage.setItem(OWNER_TG_KEY, String(id));
  } catch {
    /* ignore */
  }
}

export function getOwnerTelegramId(): string | null {
  try {
    return window.localStorage.getItem(OWNER_TG_KEY);
  } catch {
    return null;
  }
}

/** Explicit logout / completed revoke handling only. */
export function forgetLastKnownOwner(): void {
  try {
    window.localStorage.removeItem(OWNER_STORAGE_KEY);
    window.localStorage.removeItem(OWNER_TG_KEY);
  } catch {
    /* ignore */
  }
}

export function getOfflineSession(): OfflineSession | null {
  return current;
}

export function sessionKey(session: OfflineSession): string {
  return `${session.companyId}:${session.userId}`;
}

export class NoOfflineSessionError extends Error {
  readonly code = 'NO_OFFLINE_SESSION';
  constructor() {
    super('No authenticated session: cannot queue a document');
    this.name = 'NoOfflineSessionError';
  }
}
