import { clearTokens, getAccessToken, setAccessToken } from '@/lib/auth/tokens';
import type { ApiErrorBody, LocalizedMessage, TokenPair } from './types';

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

type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

/** AuthProvider registers itself here to force a logout when a request can't be recovered by a token refresh. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        // No body: the refresh token travels as the httpOnly cookie the API
        // set on login (auth.controller.ts), which `credentials: 'include'`
        // attaches automatically. There's nothing to send from JS.
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as TokenPair;
        setAccessToken(data.accessToken);
        return data.accessToken;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip attaching the access token / attempting a refresh — for /auth/login itself. */
  skipAuth?: boolean;
}

export async function apiFetch<T = void>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, skipAuth, headers, ...rest } = options;
  // FormData (image/file uploads) must keep the browser-generated multipart
  // Content-Type (with boundary) — setting it ourselves or JSON-encoding the
  // body would break the upload.
  const isFormData = body instanceof FormData;

  const send = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...rest,
      // Needed for /auth/login and /auth/logout to set/clear the httpOnly
      // refresh cookie cross-origin (web runs on a different port/origin
      // than the API); harmless no-op for every other endpoint, which the
      // cookie's Path=/auth scope excludes anyway.
      credentials: 'include',
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
    if (refreshed) {
      res = await send(refreshed);
    } else {
      clearTokens();
      unauthorizedHandlers.forEach((handler) => handler());
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
