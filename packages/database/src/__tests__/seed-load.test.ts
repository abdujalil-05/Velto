// TZ §12.5 load dataset: seed-load.ts at tiny scale must produce a ledger
// with zero integrity findings (drift 0, StockLevel = Σ movement, no
// oversell), be idempotent, and refuse any database other than velto_load.
// Needs the velto_load database (`pnpm --filter @velto/database db:load:create`);
// without it the DB cases are reported as skipped, never as passed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/client';
import { assertLoadDatabaseUrl, seedLoad, toLoadDatabaseUrl, type SeedLoadOptions } from '../seed-load';
import '../load-env';

const appUrl = process.env.DATABASE_LOAD_URL ?? toLoadDatabaseUrl(process.env.DATABASE_URL) ?? '';
const systemUrl = process.env.DATABASE_LOAD_SYSTEM_URL ?? toLoadDatabaseUrl(process.env.DATABASE_SYSTEM_URL) ?? '';

async function loadDbReachable(): Promise<boolean> {
  if (!appUrl) return false;
  const probe = new PrismaClient({ datasources: { db: { url: appUrl } } });
  try {
    await probe.$queryRaw`SELECT 1 FROM "SalesOrder" LIMIT 0`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect();
  }
}

describe('seed-load guards', () => {
  it('refuses any database other than velto_load', () => {
    expect(() => assertLoadDatabaseUrl('postgresql://velto_app:x@localhost:5433/velto_dev?schema=public', 't')).toThrow(/velto_dev/);
    expect(() => assertLoadDatabaseUrl('postgresql://velto_app:x@localhost:5433/velto_load_x', 't')).toThrow();
    expect(() => assertLoadDatabaseUrl(undefined, 't')).toThrow();
    expect(assertLoadDatabaseUrl('postgresql://velto_app:x@localhost:5433/velto_load?schema=public', 't')).toContain('velto_load');
  });

  it('refuses NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seedLoad({ ...small(), slug: 'never' })).rejects.toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

const small = (): SeedLoadOptions => ({
  appUrl, systemUrl, slug: `load-test-${randomUUID().slice(0, 8)}`,
  agents: 2, skus: 20, outlets: 12, warehouses: 2, orders: 400, chunk: 150,
});

describe('seed-load invariants (velto_load, small scale)', () => {
  const opts = small();
  let available = false;
  beforeAll(async () => {
    available = await loadDbReachable();
    if (!available) console.warn('[seed-load.test] velto_load not reachable — DB cases SKIPPED (run db:load:create)');
  });
  const app = new PrismaClient({ datasources: { db: { url: appUrl } } });
  const sys = new PrismaClient({ datasources: { db: { url: systemUrl } } });
  afterAll(() => Promise.all([app.$disconnect(), sys.$disconnect()]));

  it('seeds a consistent ledger with zero integrity findings', async (ctx) => {
    if (!available) ctx.skip();
    const r = await seedLoad(opts);
    expect(r.findings).toEqual([]);
    expect(r.ordersInserted).toBe(400);
    expect(r.counts).toMatchObject({ agents: 2, routes: 2, routeStops: 12, products: 20, warehouses: 2, customers: 12, outlets: 12, salesOrders: 400 });
    expect(r.ordersByStatus.DELIVERED).toBeGreaterThan(200);
    expect(r.counts.payments).toBeGreaterThan(0);
    expect(r.counts.stockLevels).toBeGreaterThan(0);
  }, 120_000);

  it('is idempotent: a re-run inserts nothing and stays clean', async (ctx) => {
    if (!available) ctx.skip();
    const r = await seedLoad(opts);
    expect(r.ordersInserted).toBe(0);
    expect(r.counts.salesOrders).toBe(400);
    expect(r.findings).toEqual([]);
  }, 120_000);

  it('verify-integrity.sql detects projection drift (checks are not vacuous)', async (ctx) => {
    if (!available) ctx.skip();
    const sql = readFileSync(join(__dirname, '..', '..', 'scripts', 'verify-integrity.sql'), 'utf8').trim().replace(/;\s*$/, '');
    const [company] = await sys.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM "Company" c JOIN "Tenant" t ON t.id = c."tenantId" WHERE t.slug = ${opts.slug}`;
    const rollback = new Error('rollback');
    const found = await app
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${company!.id}, true)`;
        await tx.$executeRaw`UPDATE "Customer" SET "cachedBalance" = "cachedBalance" + 1 WHERE id = (SELECT id FROM "Customer" ORDER BY code LIMIT 1)`;
        await tx.$executeRaw`UPDATE "StockLevel" SET "onHand" = "onHand" + 1 WHERE ("productId", "warehouseId") = (SELECT "productId", "warehouseId" FROM "StockLevel" LIMIT 1)`;
        const rows = await tx.$queryRawUnsafe<{ check_name: string }[]>(sql);
        throw Object.assign(rollback, { rows });
      })
      .catch((e: Error & { rows?: { check_name: string }[] }) => {
        if (e !== rollback) throw e;
        return e.rows!.map((r) => r.check_name);
      });
    expect(found).toEqual(expect.arrayContaining(['b_stock_level_drift', 'c_customer_balance_drift']));
  }, 60_000);
});
