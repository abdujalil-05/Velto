// Access token only — the refresh token lives in an httpOnly cookie set by
// the API (auth.controller.ts) and is never readable from JS here, so an
// XSS payload can no longer exfiltrate a 30-day-lived credential out of
// localStorage. The auth guard in the (app) layout still works off this:
// it checks the access token on mount and redirects if absent (there's no
// server-side session — the API is a separate NestJS service, 11.2).
const ACCESS_TOKEN_KEY = 'velto.accessToken';

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(accessToken: string): void {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}
