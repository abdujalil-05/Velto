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

export function setOfflineSession(session: OfflineSession | null): void {
  current = session;
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
