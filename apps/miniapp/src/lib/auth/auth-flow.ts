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

/** ADR-058: privileged role must sign in on the web with MFA; the miniapp never keeps a session for it. */
export function isMfaWebLoginRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.code === 'MFA_WEB_LOGIN_REQUIRED';
}

export function isMfaRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401 && e.code === 'MFA_REQUIRED';
}

export type TelegramLoginResult =
  | { kind: 'ok'; user: AuthenticatedUser }
  | { kind: 'blocked'; revoked: RevokedInfo | null }
  | { kind: 'mfa-web-required' }
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
    // 503 (Telegram/Redis/maintenance) or a network error is not a credential verdict: keep any stored tokens.
    if (isServerAuthRejection(e)) clearTokens();
    if (isMfaWebLoginRequired(e) || isMfaRequired(e)) return { kind: 'mfa-web-required' };
    if (isAccountBlocked(e)) {
      const revoked = await handleSessionRevoked().catch(() => null);
      return { kind: 'blocked', revoked };
    }
    return { kind: 'failed' };
  }
}

export type ResumeResult = { kind: 'ok'; user: AuthenticatedUser } | { kind: 'rejected' } | { kind: 'mfa-web-required' } | { kind: 'offline' };

/** Bootstrap with stored tokens. Tokens are cleared ONLY on an explicit 401/403; any network/5xx error keeps them so a later refresh can still detect a revoke. */
export async function resumeSession(): Promise<ResumeResult> {
  try {
    const me = await apiFetch<AuthenticatedUser>('/auth/me');
    setOfflineSession({ userId: me.id, companyId: me.companyId });
    return { kind: 'ok', user: me };
  } catch (e) {
    if (isMfaRequired(e)) {
      clearTokens();
      return { kind: 'mfa-web-required' };
    }
    if (isServerAuthRejection(e)) {
      clearTokens();
      return { kind: 'rejected' };
    }
    return { kind: 'offline' };
  }
}
