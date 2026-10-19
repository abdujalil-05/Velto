import { apiFetch, ApiError } from '@/lib/api/client';
import type { AuthenticatedUser, TokenPair } from '@/lib/api/types';
import { handleSessionRevoked, type RevokedInfo } from '@/lib/offline/revoke-wipe';
import { setOfflineSession, setOwnerTelegramId } from '@/lib/offline/session';
import { clearTokens, setTokens } from './tokens';

/** Server answered 401/403: the stored credentials are definitively rejected. Network failures and 5xx are NOT. */
export function isServerAuthRejection(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export function isAccountBlocked(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.code === 'AUTH_ACCOUNT_BLOCKED';
}

export type TelegramLoginResult =
  | { kind: 'ok'; user: AuthenticatedUser }
  | { kind: 'blocked'; revoked: RevokedInfo | null }
  | { kind: 'failed' };

/** /auth/telegram sign-in. A 403 AUTH_ACCOUNT_BLOCKED is a server-confirmed revoke: wipe + quarantine (TZ 8.6), never swallowed. */
export async function telegramLogin(initData: string, telegramUserId?: number | null): Promise<TelegramLoginResult> {
  try {
    const tokens = await apiFetch<TokenPair>('/auth/telegram', { method: 'POST', body: { initData }, skipAuth: true });
    setTokens(tokens.accessToken, tokens.refreshToken);
    const me = await apiFetch<AuthenticatedUser>('/auth/me');
    setOfflineSession({ userId: me.id, companyId: me.companyId });
    if (telegramUserId != null) setOwnerTelegramId(telegramUserId);
    return { kind: 'ok', user: me };
  } catch (e) {
    clearTokens();
    if (isAccountBlocked(e)) {
      const revoked = await handleSessionRevoked().catch(() => null);
      return { kind: 'blocked', revoked };
    }
    return { kind: 'failed' };
  }
}

export type ResumeResult = { kind: 'ok'; user: AuthenticatedUser } | { kind: 'rejected' } | { kind: 'offline' };

/** Bootstrap with stored tokens. Tokens are cleared ONLY on an explicit 401/403; any network/5xx error keeps them so a later refresh can still detect a revoke. */
export async function resumeSession(): Promise<ResumeResult> {
  try {
    const me = await apiFetch<AuthenticatedUser>('/auth/me');
    setOfflineSession({ userId: me.id, companyId: me.companyId });
    return { kind: 'ok', user: me };
  } catch (e) {
    if (isServerAuthRejection(e)) {
      clearTokens();
      return { kind: 'rejected' };
    }
    return { kind: 'offline' };
  }
}
