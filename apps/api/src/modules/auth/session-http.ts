import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { parseDurationMs, type RequestMeta, type TokenPair } from './auth.service';

// Scoped to /auth (not the whole API) so it's only ever sent back on the
// refresh/logout calls that need it. apps/web is the only consumer: it never
// stores the refresh token itself and relies entirely on this cookie. Telegram
// Mini App users go through /auth/telegram instead, which never sets this
// cookie — the app is iframed inside web.telegram.org (see
// apps/miniapp/next.config.mjs's frame-ancestors), a cross-site embedding
// where third-party cookie blocking would make a cookie-only flow unreliable.
// It keeps using its existing body/localStorage refresh token untouched.
export const REFRESH_COOKIE_NAME = 'velto_refresh_token';

export function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export function setRefreshCookie(res: Response, config: ConfigService, refreshToken: string): void {
  const refreshTtlMs = parseDurationMs(config.get<string>('JWT_REFRESH_TTL', '30d'));
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: config.get<string>('NODE_ENV', 'development') === 'production',
    sameSite: 'lax',
    path: '/auth',
    maxAge: refreshTtlMs,
  });
}

export function withoutRefreshToken<T extends TokenPair>(result: T): Omit<T, 'refreshToken'> {
  const rest: Partial<T> = { ...result };
  delete rest.refreshToken;
  return rest as Omit<T, 'refreshToken'>;
}
