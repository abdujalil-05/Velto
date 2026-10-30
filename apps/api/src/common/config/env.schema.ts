import { z } from 'zod';

/** Single source of the defaults; trace-job.ts / export-1c.constants.ts fall back to these. */
export const DEFAULT_QUEUE_ENQUEUE_TIMEOUT_MS = 3000;
export const DEFAULT_ABANDONED_QUEUED_MS = 24 * 60 * 60_000;
export const DEFAULT_DASHBOARD_CACHE_TTL_S = 30;
export const DEFAULT_REPORT_MAX_CONCURRENCY = 2;
export const DEFAULT_REPORT_QUEUE_MAX = 20;
export const DEFAULT_REPORT_QUEUE_TIMEOUT_MS = 10_000;
export const DEFAULT_REPORT_TENANT_MAX_CONCURRENCY = 1;
export const DEFAULT_REPORT_TENANT_QUEUE_MAX = 5;
export const DEFAULT_HEALTH_READY_CACHE_MS = 1000;

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
  // BullMQ key prefix (BullMQ's own default is 'bull', so keys are unchanged unless set). Applied once in QueueModule to every queue/worker/scheduler; use distinct values per environment sharing a Redis.
  BULLMQ_PREFIX: z.string().min(1).default('bull'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  // Telegram initData replay policy — rationale next to LoginRateLimiterService.recordTelegramInitDataUse.
  TELEGRAM_INITDATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(600),
  TELEGRAM_INITDATA_MAX_USES: z.coerce.number().int().positive().default(20),
  // Verified against Telegram's `X-Telegram-Bot-Api-Secret-Token` header on
  // every /auth/telegram/webhook call (set via setWebhook's secret_token) —
  // empty means the webhook route always rejects, same fail-closed default
  // as an unset bot token.
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  // 10.3 / F4: max documents per POST /sync/push (TZ default 20). Capped at
  // SYNC_PUSH_HARD_MAX_BATCH (sync-push.dto.ts) — the whole batch shares one
  // request transaction under Prisma's 5s timeout, so a larger value would
  // only trade a 400 for a timed-out (RETRY-everything) batch.
  SYNC_PUSH_MAX_BATCH: z.coerce.number().int().min(1).max(100).default(20),
  // GET /sync/pull lookback (seconds): the cursor never advances past rows
  // younger than this, so a slow transaction that commits a lower changeSeq
  // after a higher one is still re-sent. Must exceed 2x the request-transaction
  // timeout (5s) plus app/DB clock skew — see SyncService.pull.
  SYNC_PULL_LOOKBACK_SECONDS: z.coerce.number().int().min(20).max(3600).default(60),
  // Visit.startedAt older than this many days is REJECTED (offline queue must
  // sync within the window); more than 5 minutes in the future is always rejected.
  // 30 days: iOS evicts IndexedDB after ~7 days of inactivity, so a 7-day cap
  // would lose field data (TZ 8.4); 30 days still bounds bogus dates.
  VISIT_STARTED_AT_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
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
  // Build info surfaced by GET /health/ready (set by the deploy script; 'dev' locally).
  APP_VERSION: z.string().default('dev'),
  GIT_SHA: z.string().default('dev'),
  // Maintenance mode (ADR-051): when 'true', every POST/PUT/PATCH/DELETE answers 503
  // MAINTENANCE_READ_ONLY except routes marked @AllowDuringMaintenance (login/refresh/logout/telegram login).
  // Same literal-enum pattern as S3_FORCE_PATH_STYLE (z.coerce.boolean would turn "false" into true).
  READ_ONLY_MODE: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  // NFR-REL-006: per-enqueue timeout so a Redis outage cannot hang a request.
  QUEUE_ENQUEUE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(DEFAULT_QUEUE_ENQUEUE_TIMEOUT_MS),
  // ADR-047: an orphaned QUEUED export job older than this is failed. Min 15 minutes.
  ABANDONED_QUEUED_MS: z.coerce.number().int().min(15 * 60_000).default(DEFAULT_ABANDONED_QUEUED_MS),
  // Prisma pool sizing; bounds/defaults mirror packages/database/src/pool-config.ts (kept in sync by env.schema.test.ts).
  PRISMA_POOL_SIZE: z.coerce.number().int().min(1).max(95).default(30),
  PRISMA_SYSTEM_POOL_SIZE: z.coerce.number().int().min(1).max(95).default(5),
  PRISMA_POOL_TIMEOUT_S: z.coerce.number().int().min(1).max(120).default(10),
  // Dashboard JSON per-company in-memory cache TTL (seconds); 0 = off. Single process only (PM2 instances=1, ADR-051); multi-process needs Redis.
  DASHBOARD_CACHE_TTL_S: z.coerce.number().int().min(0).max(600).default(DEFAULT_DASHBOARD_CACHE_TTL_S),
  REPORT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(DEFAULT_REPORT_MAX_CONCURRENCY),
  REPORT_QUEUE_MAX: z.coerce.number().int().min(0).max(1000).default(DEFAULT_REPORT_QUEUE_MAX),
  REPORT_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(DEFAULT_REPORT_QUEUE_TIMEOUT_MS),
  // Per-tenant share of the report semaphore (noisy-neighbour guard); must be <= REPORT_MAX_CONCURRENCY (checked below).
  REPORT_TENANT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(DEFAULT_REPORT_TENANT_MAX_CONCURRENCY),
  REPORT_TENANT_QUEUE_MAX: z.coerce.number().int().min(0).max(1000).default(DEFAULT_REPORT_TENANT_QUEUE_MAX),
  // Dashboard's own limiter lane (separate from the heavy-report semaphore); tenant cap must be <= DASHBOARD_MAX_CONCURRENCY (checked below).
  DASHBOARD_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(DEFAULT_REPORT_MAX_CONCURRENCY),
  DASHBOARD_TENANT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(DEFAULT_REPORT_TENANT_MAX_CONCURRENCY),
  DASHBOARD_QUEUE_MAX: z.coerce.number().int().min(0).max(1000).default(DEFAULT_REPORT_QUEUE_MAX),
  DASHBOARD_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(DEFAULT_REPORT_QUEUE_TIMEOUT_MS),
  DASHBOARD_TENANT_QUEUE_MAX: z.coerce.number().int().min(0).max(1000).default(DEFAULT_REPORT_TENANT_QUEUE_MAX),
  // /health/ready result cache (ms); concurrent probes share one in-flight check. 0 = no cache (still single-flight).
  HEALTH_READY_CACHE_MS: z.coerce.number().int().min(0).max(30_000).default(DEFAULT_HEALTH_READY_CACHE_MS),
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
})
  .refine((e) => e.REPORT_TENANT_MAX_CONCURRENCY <= e.REPORT_MAX_CONCURRENCY, {
    path: ['REPORT_TENANT_MAX_CONCURRENCY'],
    message: 'must be <= REPORT_MAX_CONCURRENCY',
  })
  .refine((e) => e.DASHBOARD_TENANT_MAX_CONCURRENCY <= e.DASHBOARD_MAX_CONCURRENCY, {
    path: ['DASHBOARD_TENANT_MAX_CONCURRENCY'],
    message: 'must be <= DASHBOARD_MAX_CONCURRENCY',
  })
  // A compute holds up to 6 connections; both lanes at capacity plus a 6-connection reserve must fit the app pool
  // (PRISMA_POOL_SIZE already defaults to DEFAULT_APP_POOL_SIZE, kept in sync by env.schema.test.ts).
  .refine((e) => e.PRISMA_POOL_SIZE >= 6 * (e.REPORT_MAX_CONCURRENCY + e.DASHBOARD_MAX_CONCURRENCY) + 6, {
    path: ['PRISMA_POOL_SIZE'],
    message: 'must be >= 6 x (REPORT_MAX_CONCURRENCY + DASHBOARD_MAX_CONCURRENCY) + 6',
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return result.data;
}
