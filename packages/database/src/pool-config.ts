/**
 * Explicit Prisma connection-pool sizing (F7 load run, docs/perf/F7-load-report.md).
 *
 * Without `connection_limit` in the URL Prisma sizes each client's pool as
 * `num_cpus * 2 + 1` (17 on the load host) — every API request holds one
 * connection for its whole TenantContextInterceptor transaction, so at 100 VU
 * reads failed with "Unable to start a transaction in the given time".
 *
 * Budget against Postgres `max_connections` (100 locally, 3 reserved for
 * superuser): per API process the RLS-bound `velto_app` pool and the BYPASSRLS
 * `velto_system` pool are SEPARATE pools and add up (BullMQ workers run
 * in-process and share them). Defaults 30 + 5 = 35 per process leave room for
 * a second process, migrations (`velto_owner`), seed/bootstrap scripts,
 * backups and psql sessions. Behind PgBouncer (transaction mode) the limit is
 * per client against the bouncer's pool, so size `default_pool_size` to cover
 * all processes; on a managed Postgres check its own connection cap.
 *
 * A value already present in the URL always wins (an operator who tuned the
 * URL is never silently overridden).
 */
export const DEFAULT_APP_POOL_SIZE = 30;
export const DEFAULT_SYSTEM_POOL_SIZE = 5;
export const DEFAULT_POOL_TIMEOUT_S = 10;
/** Sanity cap: a single process pool must stay below Postgres' default max_connections. */
export const MAX_POOL_SIZE = 95;
export const MAX_POOL_TIMEOUT_S = 120;

export type PoolSettings = { connectionLimit: number; poolTimeoutS: number };

function parseIntEnv(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  const value = Number(trimmed);
  if (value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

/** Reads pool settings from env; throws on malformed values (fail fast at client construction). */
export function resolvePoolSettings(
  env: NodeJS.ProcessEnv,
  kind: 'app' | 'system',
): PoolSettings {
  const sizeVar = kind === 'app' ? 'PRISMA_POOL_SIZE' : 'PRISMA_SYSTEM_POOL_SIZE';
  const sizeDefault = kind === 'app' ? DEFAULT_APP_POOL_SIZE : DEFAULT_SYSTEM_POOL_SIZE;
  return {
    connectionLimit: parseIntEnv(sizeVar, env[sizeVar], sizeDefault, 1, MAX_POOL_SIZE),
    poolTimeoutS: parseIntEnv('PRISMA_POOL_TIMEOUT_S', env.PRISMA_POOL_TIMEOUT_S, DEFAULT_POOL_TIMEOUT_S, 1, MAX_POOL_TIMEOUT_S),
  };
}

/**
 * Appends `connection_limit` / `pool_timeout` to a Postgres URL unless the URL
 * already carries them. String-level edit (no URL re-serialisation) so
 * percent-encoded credentials and other params stay byte-identical.
 */
export function withPoolParams(url: string, settings: PoolSettings): string {
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = base.indexOf('?');
  const params = new URLSearchParams(queryAt === -1 ? '' : base.slice(queryAt + 1));

  const additions: string[] = [];
  if (!params.has('connection_limit')) additions.push(`connection_limit=${settings.connectionLimit}`);
  if (!params.has('pool_timeout')) additions.push(`pool_timeout=${settings.poolTimeoutS}`);
  if (additions.length === 0) return url;

  const separator = queryAt === -1 ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${separator}${additions.join('&')}${fragment}`;
}

/** Datasource URL for a client, or undefined when the env var is unset (Prisma then reports it as before). */
export function pooledUrl(url: string | undefined, env: NodeJS.ProcessEnv, kind: 'app' | 'system'): string | undefined {
  if (!url) return undefined;
  return withPoolParams(url, resolvePoolSettings(env, kind));
}
