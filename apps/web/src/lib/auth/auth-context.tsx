'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, onUnauthorized } from '@/lib/api/client';
import { isCompanySelection, loginRequest, selectCompanyRequest, type CompanySelectionRequired } from '@/lib/api/auth';
import type { AuthenticatedUser, TokenPair } from '@/lib/api/types';
import { clearTokens, getAccessToken, setAccessToken } from './tokens';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  user: AuthenticatedUser | null;
  status: AuthStatus;
  /** Resolves to a company challenge (no session yet) or null when logged in. */
  login: (phone: string, password: string) => Promise<CompanySelectionRequired | null>;
  selectCompany: (challengeId: string, optionId: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (code: string) => boolean;
  hasAnyRole: (...codes: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!getAccessToken()) {
        if (!cancelled) setStatus('unauthenticated');
        return;
      }
      try {
        // 15.2/auth.controller.ts: re-hydrate from the server on load — the
        // JWT payload is never trusted for permissions, only the DB is.
        const me = await apiFetch<AuthenticatedUser>('/auth/me');
        if (!cancelled) {
          setUser(me);
          setStatus('authenticated');
        }
      } catch {
        clearTokens();
        if (!cancelled) {
          setUser(null);
          setStatus('unauthenticated');
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setStatus('unauthenticated');
      }),
    [],
  );

  const startSession = useCallback(async (tokens: TokenPair) => {
    // No refresh token here — the API set it as an httpOnly cookie
    // (auth.controller.ts); only the access token is ours to keep.
    setAccessToken(tokens.accessToken);
    const me = await apiFetch<AuthenticatedUser>('/auth/me');
    setUser(me);
    setStatus('authenticated');
  }, []);

  const login = useCallback(
    async (phone: string, password: string) => {
      const res = await loginRequest(phone, password);
      if (isCompanySelection(res)) return res;
      // Never treat a response without an access token as logged in.
      if (!res || typeof res.accessToken !== 'string' || !res.accessToken) {
        throw new Error('Invalid login response');
      }
      await startSession(res);
      return null;
    },
    [startSession],
  );

  const selectCompany = useCallback(
    async (challengeId: string, optionId: string) => {
      const res = await selectCompanyRequest(challengeId, optionId);
      if (!res || typeof res.accessToken !== 'string' || !res.accessToken) {
        throw new Error('Invalid login response');
      }
      await startSession(res);
    },
    [startSession],
  );

  const logout = useCallback(async () => {
    clearTokens();
    setUser(null);
    setStatus('unauthenticated');
    // No body needed — the API reads/clears the refresh cookie itself.
    apiFetch('/auth/logout', { method: 'POST', skipAuth: true }).catch(() => {});
  }, []);

  const hasPermission = useCallback((code: string) => user?.permissions.includes(code) ?? false, [user]);
  const hasAnyRole = useCallback(
    (...codes: string[]) => (user ? codes.some((c) => user.roles.includes(c)) : false),
    [user],
  );

  return (
    <AuthContext.Provider value={{ user, status, login, selectCompany, logout, hasPermission, hasAnyRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
