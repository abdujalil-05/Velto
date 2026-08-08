'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { apiFetch, onUnauthorized } from '@/lib/api/client';
import type { AuthenticatedUser, TokenPair } from '@/lib/api/types';
import { getTelegramWebApp } from '@/lib/telegram/webapp';
import { clearOfflineDb } from '@/lib/offline/db';
import { queueRepository } from '@/lib/offline/queue';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from './tokens';

// 'no-telegram-context': no stored session AND no Telegram initData —
// i.e. this device has never logged in before and isn't inside Telegram
// (opened the bare URL in a normal browser). 'needs-phone-link': inside
// Telegram with valid initData, but no User.telegramId matches yet — the
// first-ever open for an agent whose phone the backend hasn't linked (see
// linkPhone() below). Distinct from 'unauthenticated' (had a session, e.g.
// logout or an expired/revoked refresh token) so the UI can tell these
// apart from a normal logged-out state.
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'no-telegram-context' | 'needs-phone-link';

interface AuthContextValue {
  user: AuthenticatedUser | null;
  status: AuthStatus;
  logout: () => Promise<void>;
  hasPermission: (code: string) => boolean;
  linkPhone: () => Promise<void>;
  linking: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('Common');
  const tAuth = useTranslations('Auth');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [linking, setLinking] = useState(false);

  // Shared by the initial bootstrap and the post-link retry: attempts a
  // Telegram login with the current initData, returns whether it succeeded.
  const tryTelegramLogin = useCallback(async (initData: string): Promise<boolean> => {
    try {
      const tokens = await apiFetch<TokenPair>('/auth/telegram', {
        method: 'POST',
        body: { initData },
        skipAuth: true,
      });
      setTokens(tokens.accessToken, tokens.refreshToken);
      const me = await apiFetch<AuthenticatedUser>('/auth/me');
      setUser(me);
      setStatus('authenticated');
      return true;
    } catch {
      clearTokens();
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      // PWA fallback (plan §2): a device that already logged in once via
      // Telegram keeps its refresh token in local storage, so reopening
      // the same URL as a home-screen PWA re-authenticates via the
      // ordinary refresh flow (apiFetch's 401 handler) without needing
      // initData again.
      if (getAccessToken() || getRefreshToken()) {
        try {
          const me = await apiFetch<AuthenticatedUser>('/auth/me');
          if (!cancelled) {
            setUser(me);
            setStatus('authenticated');
          }
        } catch {
          clearTokens();
          if (!cancelled) setStatus('unauthenticated');
        }
        return;
      }

      const initData = getTelegramWebApp()?.initData;
      if (!initData) {
        if (!cancelled) setStatus('no-telegram-context');
        return;
      }

      const ok = await tryTelegramLogin(initData);
      if (!cancelled && !ok) {
        // Valid Telegram context but no User.telegramId matched yet — the
        // expected state for an agent's very first open, not a real error.
        setStatus('needs-phone-link');
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [tryTelegramLogin]);

  // Prompts the native "share phone number" popup, then polls /auth/telegram
  // for a few seconds — the number itself lands on the bot as a message and
  // gets linked server-side (POST /auth/telegram/webhook), asynchronously
  // relative to this popup closing, so there's no single "linked now" event
  // to await.
  const linkPhone = useCallback(async () => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;
    const initData = webApp.initData;

    setLinking(true);
    try {
      const shared = await new Promise<boolean>((resolve) => webApp.requestContact(resolve));
      if (!shared) return;

      for (let attempt = 0; attempt < 9; attempt++) {
        await sleep(1000);
        if (await tryTelegramLogin(initData)) return;
      }
      // Webhook never linked the phone within the polling window (not
      // found, ambiguous across companies, or already linked elsewhere —
      // see linkTelegramContact() server-side, which messages the user in
      // the bot chat with the specific reason). Without this, the button
      // silently resets with zero indication anything happened.
      toast.error(tAuth('linkTimeout'));
    } finally {
      setLinking(false);
    }
  }, [tryTelegramLogin, tAuth]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setStatus('unauthenticated');
      }),
    [],
  );

  const logout = useCallback(async () => {
    // 10.3's "asosiy tamoyil" (a document that reached local storage is
    // never silently lost) extends to logout: wiping the offline DB while
    // unsynced orders/visits/payments sit in the queue would discard real
    // field work, and a next login (possibly a different agent, on a
    // shared device) must not start with a stale queue trying to sync
    // under the wrong session either — so logout is blocked, not silently
    // deferred, until the queue is actually empty.
    const pending = await queueRepository.listAll();
    const unsynced = pending.filter((e) => e.status !== 'SYNCED').length;
    if (unsynced > 0) {
      toast.error(t('logoutBlockedPendingSync', { count: unsynced }));
      return;
    }

    const refreshToken = getRefreshToken();
    clearTokens();
    await clearOfflineDb();
    setUser(null);
    setStatus('unauthenticated');
    if (refreshToken) {
      apiFetch('/auth/logout', { method: 'POST', body: { refreshToken }, skipAuth: true }).catch(() => {});
    }
  }, [t]);

  const hasPermission = useCallback((code: string) => user?.permissions.includes(code) ?? false, [user]);

  return (
    <AuthContext.Provider value={{ user, status, logout, hasPermission, linkPhone, linking }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
