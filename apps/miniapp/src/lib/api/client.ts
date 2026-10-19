import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/lib/auth/tokens';
import type { ApiErrorBody, LocalizedMessage, TokenPair } from './types';

// Copied from apps/web/src/lib/api/client.ts — same shape (see the plan's
// rationale: no shared packages/ui or api-client package exists to reuse
// instead).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly localizedMessage: LocalizedMessage;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message?.en ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? `HTTP_${status}`;
    this.localizedMessage = body.message;
    this.details = body.details;
  }
}

/** Reads the trilingual message for the given app locale, falling back to English. */
export function errorMessage(error: unknown, locale: string): string {
  if (error instanceof ApiError) {
    return error.localizedMessage[locale as keyof LocalizedMessage] ?? error.localizedMessage.en;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `revoked`: the server itself rejected the refresh token (401/403). A network error / 5xx is NOT a revoke (offline must never wipe). */
export interface UnauthorizedInfo {
  revoked: boolean;
}
type UnauthorizedHandler = (info: UnauthorizedInfo) => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

/** AuthProvider registers itself here to force a logout when a request can't be recovered by a token refresh. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

let refreshInFlight: Promise<RefreshResult> | null = null;

/** `rejected`: refresh answered 401/403. `revoked`: ONLY the server's explicit AUTH_ACCOUNT_BLOCKED (user/company disabled). AUTH_SESSION_EXPIRED is shared by expired, rotated-reuse and unknown tokens, so it can never trigger a wipe. */
type RefreshResult = { token: string } | { rejected: boolean; revoked: boolean };
export const REVOKE_ERROR_CODES: readonly string[] = ['AUTH_ACCOUNT_BLOCKED'];

async function refreshAccessToken(): Promise<RefreshResult> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return { rejected: false, revoked: false };

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (res.status === 401 || res.status === 403) {
          const body = (await res.json().catch(() => null)) as { code?: string } | null;
          return { rejected: true, revoked: res.status === 403 && !!body?.code && REVOKE_ERROR_CODES.includes(body.code) };
        }
        if (!res.ok) return { rejected: false, revoked: false };
        const data = (await res.json()) as TokenPair;
        setTokens(data.accessToken, data.refreshToken);
        return { token: data.accessToken };
      } catch {
        return { rejected: false, revoked: false };
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip attaching the access token / attempting a refresh — for /auth/telegram itself. */
  skipAuth?: boolean;
}

export async function apiFetch<T = void>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, skipAuth, headers, ...rest } = options;
  const isFormData = body instanceof FormData;

  const send = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...rest,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send(skipAuth ? null : getAccessToken());

  if (res.status === 401 && !skipAuth) {
    const refreshed = await refreshAccessToken();
    if ('token' in refreshed) {
      res = await send(refreshed.token);
    } else {
      // Tokens are dropped only when the server refused them; on a network/5xx
      // failure they stay so the next online attempt can still refresh.
      if (refreshed.rejected) clearTokens();
      unauthorizedHandlers.forEach((handler) => handler({ revoked: refreshed.revoked }));
    }
  }

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, (data as ApiErrorBody) ?? { code: `HTTP_${res.status}`, message: { uz: '', ru: '', en: '' } });
  }

  return data as T;
}
