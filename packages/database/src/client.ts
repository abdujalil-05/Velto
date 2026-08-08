import { PrismaClient, Prisma } from '../generated/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RLS-bound client (Postgres role `velto`). All per-tenant reads/writes must
 * go through `withTenant()` below — a bare `prisma.customer.findMany()` etc.
 * outside a tenant transaction will see zero rows (6.10 fails closed, not
 * open) because `app.current_company_id` was never set on that connection.
 */
export const prisma = new PrismaClient();

/**
 * BYPASSRLS client (Postgres role `velto_system`, see
 * scripts/provision-roles.sql). Reserved for the narrow set of operations
 * that must legitimately see across tenants before a company context is
 * known: resolving a user by phone during `POST /auth/login` (companyId is
 * intentionally not part of the login request — VELTO-TZ.md 15.2),
 * platform-admin provisioning scripts, and cross-tenant background jobs.
 * Once such code knows which companyId it's operating on, it should switch
 * to `withTenant()` for the actual mutation rather than keep using this.
 */
export const systemPrisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_SYSTEM_URL } },
});

export type TenantClient = Prisma.TransactionClient;

/**
 * Runs `fn` inside a transaction with `app.current_company_id` set via
 * `SET LOCAL` (through `set_config(..., true)`, which is what actually makes
 * every tenant-scoped RLS policy in prisma/migrations/*_rls_and_audit_lock
 * evaluate to true for this company's rows). The whole callback shares one
 * transaction, since `SET LOCAL` only lives for the current transaction.
 */
export async function withTenant<T>(
  companyId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(companyId)) {
    throw new Error(`withTenant: "${companyId}" is not a valid companyId`);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    return fn(tx);
  });
}

const SAVEPOINT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Runs `fn` inside a Postgres SAVEPOINT so a caught error (e.g. a unique
 * violation used for idempotency) doesn't leave the *whole* surrounding
 * transaction aborted — Postgres marks a transaction aborted (25P02) after
 * any failed statement, and a plain try/catch around `fn` doesn't undo that
 * server-side state, so every later query on the same `tx` would fail too.
 * `ROLLBACK TO SAVEPOINT` undoes just `fn`'s work and lets the transaction
 * keep going.
 */
export async function withSavepoint<T>(tx: TenantClient, name: string, fn: () => Promise<T>): Promise<T> {
  if (!SAVEPOINT_NAME_RE.test(name)) {
    throw new Error(`withSavepoint: "${name}" is not a safe savepoint identifier`);
  }
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}
