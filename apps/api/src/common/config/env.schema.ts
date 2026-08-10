import { z } from 'zod';

/** Fails fast on boot if required env vars are missing/malformed, instead of failing on the first request that needs them. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  // Defaults to every interface for container/dev parity; a reverse-proxied
  // deploy sets this to 127.0.0.1 so the plaintext API is only reachable via
  // nginx, not directly if a firewall rule ever slips.
  API_HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SYSTEM_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  // Verified against Telegram's `X-Telegram-Bot-Api-Secret-Token` header on
  // every /auth/telegram/webhook call (set via setWebhook's secret_token) —
  // empty means the webhook route always rejects, same fail-closed default
  // as an unset bot token.
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  // Bot @username (without the "@"), used only to build the
  // `https://t.me/<username>?start=<code>` deep link a supplier taps to redeem
  // a SupplierTelegramLinkCode. Empty (the default) makes the API return
  // `deepLink: null` rather than a broken URL — the raw code is still usable,
  // so this stays optional like TELEGRAM_BOT_TOKEN itself.
  TELEGRAM_BOT_USERNAME: z.string().default(''),
  // Comma-separated list of origins allowed to call the API with credentials
  // (SEC-040..048: CORS must not be wide-open). Web and Mini App dev ports by default.
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3002'),
  // 11.7 "xato tracker ulandi" — empty disables Sentry entirely (dev default),
  // same optional-integration pattern as TELEGRAM_BOT_TOKEN.
  SENTRY_DSN: z.string().default(''),
  // INT-SMS-001: password-reset codes go out over Eskiz.uz (the most widely
  // used SMS gateway for Uzbek numbers). Empty token — same optional-
  // integration default as TELEGRAM_BOT_TOKEN/SENTRY_DSN — logs the code
  // instead of sending it, so the reset flow works in dev without an account.
  SMS_API_TOKEN: z.string().default(''),
  SMS_SENDER: z.string().default('4546'),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  // z.coerce.boolean() applies JS `Boolean(str)` semantics — any non-empty
  // string, including the literal "false", coerces to true, so
  // S3_FORCE_PATH_STYLE=false in the environment would silently become
  // true. Accept only the literal "true"/"false" instead, matching this
  // file's "fails fast on malformed config" intent.
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  // When the API sits behind a reverse proxy (nginx terminating TLS and
  // forwarding via X-Forwarded-For/-Proto), Express's req.ip is 127.0.0.1
  // for every request unless it's told to trust that hop — which silently
  // breaks IP-scoped rate limiting (SEC-045, all clients bucket together)
  // and AuditLog's recorded client IP. Same z.enum (not z.coerce.boolean())
  // pattern as S3_FORCE_PATH_STYLE, for the same reason. Default 'false' so
  // local dev / CI (no proxy in front) keep using the raw socket address.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return result.data;
}
