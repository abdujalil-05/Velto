'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { apiFetch, onUnauthorized } from '@/lib/api/client';
import type { AuthenticatedUser } from '@/lib/api/types';
import { getTelegramWebApp } from '@/lib/telegram/webapp';
import { clearOfflineDb } from '@/lib/offline/db';
import { clearDeviceKey } from '@/lib/offline/crypto';
import { queueRepository } from '@/lib/offline/queue';
import { forgetLastKnownOwner, setOfflineSession } from '@/lib/offline/session';
import { clearRevokedInfo, getRevokedInfo, handleSessionRevoked, type RevokedInfo } from '@/lib/offline/revoke-wipe';
import { resetPreparedSession } from '@/lib/offline/session-bootstrap';
import { clearTokens, getAccessToken, getRefreshToken } from './tokens';
import { resumeSession, telegramLogin } from './auth-flow';

// 'no-telegram-context': no stored session AND no Telegram initData —
// i.e. this device has never logged in before and isn't inside Telegram
// (opened the bare URL in a normal browser). 'needs-phone-link': inside
// Telegram with valid initData, but no User.telegramId matches yet — the
// first-ever open for an agent whose phone the backend hasn't linked (see
// linkPhone() below). Distinct from 'unauthenticated' (had a session, e.g.
// logout or an expired/revoked refresh token) so the UI can tell these
// apart from a normal logged-out state.
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'mfa-web-required' | 'no-telegram-context' | 'needs-phone-link';

interface AuthContextValue {
  user: AuthenticatedUser | null;
  status: AuthStatus;
  /** Blocked while the current user has unsynced (or quarantined) documents. `force` is only for the explicit export/discard flow and deletes ONLY the current user's own documents; other owners' rows are kept. */
  logout: (opts?: { force?: boolean }) => Promise<void>;
  hasPermission: (code: string) => boolean;
  linkPhone: () => Promise<void>;
  linking: boolean;
  /** Set after a server-confirmed revoke while quarantined documents remain on this device. */
  revoked: RevokedInfo | null;
  /** Called after export/discard (re-evaluates) or "continue" (hides the notice). */
  resolveRevoked: (opts?: { hide?: boolean }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('Common');
  const tAuth = useTranslations('Auth');
  const tRevoked = useTranslations('Revoked');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [linking, setLinking] = useState(false);
  const [revoked, setRevoked] = useState<RevokedInfo | null>(null);
  useEffect(() => setRevoked(getRevokedInfo()), []);

  // Shared by the initial bootstrap and the post-link retry: attempts a
  // Telegram login with the current initData, returns whether it succeeded.
  const tryTelegramLogin = useCallback(async (initData: string): Promise<'ok' | 'blocked' | 'mfa-web-required' | 'failed'> => {
    const res = await telegramLogin(initData, getTelegramWebApp()?.initDataUnsafe?.user?.id);
    if (res.kind === 'ok') {
      setUser(res.user);
      setStatus('authenticated');
    } else if (res.kind === 'mfa-web-required') {
      setStatus('mfa-web-required');
    } else if (res.kind === 'blocked') {
      setRevoked(res.revoked);
      if (!res.revoked) toast.error(tRevoked('wipedToast'));
    }
    return res.kind;
  }, [tRevoked]);

  // Bootstrap can only leave 'loading' when a fetch settles, and a fetch to an
  // unreachable host does not settle quickly — a phone inside Telegram hitting
  // a dead tunnel or a localhost NEXT_PUBLIC_API_URL sits on the OS-level TCP
  // timeout (tens of seconds, sometimes never on a flaky mobile link). That
  // rendered as a spinner forever with no explanation, which is the "app
  // doesn't open" report. Cap it: after this long, fall through to the
  // fallback screen, which offers the bot deep link and a retry.
  const BOOTSTRAP_TIMEOUT_MS = 15_000;

  useEffect(() => {
    let cancelled = false;

    const watchdog = setTimeout(() => {
      if (cancelled) return;
      // Only downgrade a still-unresolved bootstrap; never clobber a status a
      // settled request already set.
      setStatus((current) => (current === 'loading' ? 'unauthenticated' : current));
    }, BOOTSTRAP_TIMEOUT_MS);

    async function bootstrap() {
      // PWA fallback (plan §2): a device that already logged in once via
      // Telegram keeps its refresh token in local storage, so reopening
      // the same URL as a home-screen PWA re-authenticates via the
      // ordinary refresh flow (apiFetch's 401 handler) without needing
      // initData again.
      if (getAccessToken() || getRefreshToken()) {
        const res = await resumeSession();
        if (!cancelled) {
          if (res.kind === 'ok') {
            setUser(res.user);
            setStatus('authenticated');
          } else if (res.kind === 'mfa-web-required') {
            setStatus('mfa-web-required');
          } else {
            setStatus('unauthenticated');
          }
        }
        return;
      }

      const initData = getTelegramWebApp()?.initData;
      if (!initData) {
        if (!cancelled) setStatus('no-telegram-context');
        return;
      }

      const outcome = await tryTelegramLogin(initData);
      if (!cancelled && outcome === 'mfa-web-required') {
        setStatus('mfa-web-required');
      } else if (!cancelled && outcome === 'blocked') {
        setStatus('unauthenticated');
      } else if (!cancelled && outcome === 'failed') {
        // Valid Telegram context but no User.telegramId matched yet — the
        // expected state for an agent's very first open, not a real error.
        setStatus('needs-phone-link');
      }
    }

    bootstrap().finally(() => clearTimeout(watchdog));
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
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
        const outcome = await tryTelegramLogin(initData);
        if (outcome !== 'failed') return;
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
      onUnauthorized(({ revoked: serverRejected, mfaRequired }) => {
        // Wipe ONLY when the server confirmed the account/company is BLOCKED
        // (api client sets `revoked` solely on 403 AUTH_ACCOUNT_BLOCKED). An
        // ordinary expired/invalid refresh token or a network failure only ends
        // the in-memory session — nothing is wiped, adopted or re-tagged.
        if (serverRejected) {
          void handleSessionRevoked()
            .then((info) => {
              setRevoked(info);
              if (!info) toast.error(tRevoked('wipedToast'));
            })
            .catch(() => {});
        }
        setOfflineSession(null);
        resetPreparedSession();
        setUser(null);
        setStatus(mfaRequired ? 'mfa-web-required' : 'unauthenticated');
      }),
    [tRevoked],
  );

  const logout = useCallback(async (opts?: { force?: boolean }) => {
    // 10.3's "asosiy tamoyil" (a document that reached local storage is
    // never silently lost) extends to logout: wiping the offline DB while
    // unsynced orders/visits/payments sit in the queue would discard real
    // field work, and a next login (possibly a different agent, on a
    // shared device) must not start with a stale queue trying to sync
    // under the wrong session either — so logout is blocked, not silently
    // deferred, until the queue is actually empty.
    const unsynced = await queueRepository.unsyncedCountForLogout();
    if (unsynced > 0 && !opts?.force) {
      toast.error(t('logoutBlockedPendingSync', { count: unsynced }));
      return;
    }

    // `force` (after export/confirmed discard) deletes ONLY the current user's
    // own rows. Other owners' / quarantined unsynced documents are never
    // destroyed by someone else.
    if (opts?.force) await queueRepository.deleteOwnEntries();
    const foreignRows = await queueRepository.queueRowCount();

    const refreshToken = getRefreshToken();
    clearTokens();
    await clearOfflineDb({ keepQueue: foreignRows > 0 });
    // Rotate the device key only when the queue is empty: rotating it while
    // foreign unsynced rows exist would make them undecryptable (= destroyed).
    // Trade-off: with surviving foreign rows the next user shares the key, but
    // they only ever see rows tagged with their own owner (queue.ts listAll).
    if (foreignRows === 0) clearDeviceKey();
    setOfflineSession(null);
    forgetLastKnownOwner();
    resetPreparedSession();
    setUser(null);
    setStatus('unauthenticated');
    if (refreshToken) {
      apiFetch('/auth/logout', { method: 'POST', body: { refreshToken }, skipAuth: true }).catch(() => {});
    }
  }, [t]);

  const resolveRevoked = useCallback(async (opts?: { hide?: boolean }) => {
    const info = getRevokedInfo();
    if (info && !opts?.hide && (await queueRepository.listRevokedFor(info)).length === 0) {
      clearRevokedInfo();
      if ((await queueRepository.queueRowCount()) === 0) clearDeviceKey();
      setRevoked(null);
    } else if (opts?.hide) {
      setRevoked(null);
    }
  }, []);

  const hasPermission = useCallback((code: string) => user?.permissions.includes(code) ?? false, [user]);

  return (
    <AuthContext.Provider value={{ user, status, logout, hasPermission, linkPhone, linking, revoked, resolveRevoked }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
