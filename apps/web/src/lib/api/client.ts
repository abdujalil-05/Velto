import { clearTokens, getAccessToken, setAccessToken } from '@/lib/auth/tokens';
import type { ApiErrorBody, LocalizedMessage, TokenPair } from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly localizedMessage: LocalizedMessage;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    const message = normalizeMessage(body?.message, status);
    super(message.en);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? `HTTP_${status}`;
    this.localizedMessage = message;
    this.details = body?.details;
  }
}

/**
 * Not every failure comes back through the global exception filter's
 * `{ code, message: { uz, ru, en } }` contract — a Nest validation pipe, a
 * proxy 502 or a non-JSON body can produce a bare string (or nothing), and
 * indexing that as a LocalizedMessage used to yield `undefined` (a blank
 * error toast) or throw. Coerce whatever arrived into a full trilingual
 * object once, here, so every consumer can rely on the contract.
 */
function normalizeMessage(message: unknown, status: number): LocalizedMessage {
  const fallback = `Request failed with status ${status}`;
  if (typeof message === 'string' && message) {
    return { uz: message, ru: message, en: message };
  }
  if (message && typeof message === 'object') {
    const m = message as Partial<LocalizedMessage>;
    const en = m.en || m.ru || m.uz || fallback;
    return { uz: m.uz || en, ru: m.ru || en, en };
  }
  return { uz: fallback, ru: fallback, en: fallback };
}

/** Reads the trilingual message for the given app locale, falling back to English. */
export function errorMessage(error: unknown, locale: string): string {
  if (error instanceof ApiError) {
    const message = error.localizedMessage;
    return message[locale as keyof LocalizedMessage] || message.en || error.message;
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

/** Non-secret flag read once by the login page to explain why the session ended (ADR-058). */
export const AUTH_NOTICE_KEY = 'velto.authNotice';

export function consumeAuthNotice(): string | null {
  try {
    const v = window.sessionStorage.getItem(AUTH_NOTICE_KEY);
    window.sessionStorage.removeItem(AUTH_NOTICE_KEY);
    return v;
  } catch {
    return null;
  }
}

/** MFA_REQUIRED is not an expired token: refreshing cannot fix it, so never enter the refresh path. */
async function isMfaRequired(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { code?: string };
    return body?.code === 'MFA_REQUIRED';
  } catch {
    return false;
  }
}

function endSessionForMfa() {
  clearTokens();
  try {
    window.sessionStorage.setItem(AUTH_NOTICE_KEY, 'mfaRequired');
  } catch {
    // storage unavailable: the redirect still happens, only the message is lost
  }
  unauthorizedHandlers.forEach((handler) => handler());
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

  if (res.status === 401 && !skipAuth && (await isMfaRequired(res))) {
    endSessionForMfa();
    throw new ApiError(401, (await res.json().catch(() => undefined)) as ApiErrorBody);
  }

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
    throw new ApiError(res.status, data as ApiErrorBody);
  }

  return data as T;
}

/**
 * Streams a binary response (.xlsx export / import template) straight to a
 * browser download. Goes through the same token attachment, single silent
 * `/auth/refresh` retry and typed `ApiError` handling as `apiFetch` — a failed
 * export has to surface the backend's trilingual message like every other
 * error, not a raw English string.
 */
export async function apiDownloadWithHash(path: string, fallbackFilename: string): Promise<{ sha256: string | null }> {
  const send = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  let res = await send(getAccessToken());

  if (res.status === 401 && (await isMfaRequired(res))) {
    endSessionForMfa();
    throw new ApiError(401, (await res.json().catch(() => undefined)) as ApiErrorBody);
  }

  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await send(refreshed);
    } else {
      clearTokens();
      unauthorizedHandlers.forEach((handler) => handler());
    }
  }

  if (!res.ok) {
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const body = isJson ? ((await res.json().catch(() => undefined)) as ApiErrorBody | undefined) : undefined;
    throw new ApiError(res.status, body as ApiErrorBody);
  }

  const blob = await res.blob();
  // Prefer the server's own filename when it sent one (import templates do).
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? fallbackFilename;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  // Only readable cross-origin if the API lists it in Access-Control-Expose-Headers.
  return { sha256: res.headers.get('x-content-sha256') };
}

export async function apiDownload(path: string, fallbackFilename: string): Promise<void> {
  await apiDownloadWithHash(path, fallbackFilename);
}
