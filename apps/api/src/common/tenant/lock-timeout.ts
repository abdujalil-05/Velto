import type { TenantClient } from '@velto/database';

/**
 * F7: per-document lock wait cap for the hot writer paths (POST /orders,
 * each /sync/push document). A lock wait longer than this fails fast as
 * Postgres 55P03 (lock_not_available) instead of burning the whole 5 s tx
 * timeout (P2028, outcome unclear). 55P03 aborts the statement, the tenant tx
 * rolls back -> AllExceptionsFilter 503 SERVICE_BUSY / sync RETRY.
 * `SET LOCAL` = this transaction only; it never leaks to the pooled connection.
 */
export async function setWriterLockTimeout(tx: TenantClient): Promise<void> {
  // SET takes no bind parameters; constant literal, nothing interpolated.
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
}
