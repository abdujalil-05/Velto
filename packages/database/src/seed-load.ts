// Synthetic load dataset for the canonical NFR profile (TZ §12.5): one tenant,
// 20 agents (one route each), 2k SKU, 1k customers/outlets, 3 warehouses,
// 100k sales orders with a consistent stock ledger and finance ledger.
//
// Writes ONLY to a database literally named `velto_load` (URL path AND
// current_database() are checked on every connection) and refuses
// NODE_ENV=production. Never touches velto_dev.
//
//   pnpm --filter @velto/database db:load:seed [--agents=20 --skus=2000 --outlets=1000
//       --warehouses=3 --orders=100000 --chunk=10000 --slug=load --reset]
//
// URLs: --url / DATABASE_LOAD_URL (velto_app, RLS-bound) and --system-url /
// DATABASE_LOAD_SYSTEM_URL (velto_system, only for Tenant/Company/Permission
// provisioning, exactly like seed.ts). Defaults: DATABASE_URL /
// DATABASE_SYSTEM_URL with the database name swapped to velto_load.
//
// Every tenant row is written by the app role inside a transaction with
// app.current_company_id set, so RLS + FORCE and the same-company triggers
// are exercised, not bypassed. History is generated set-based in Postgres
// (INSERT … SELECT generate_series, deterministic hashtext() "randomness"),
// one atomic transaction per chunk of orders — an interrupted run resumes
// from the last committed chunk. Append-only ledgers cannot be deleted, so
// --reset drops and recreates the whole velto_load database
// (scripts/load-db.sh reset) instead.
import './load-env';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import argon2 from 'argon2';
import { PrismaClient, Prisma } from '../generated/client';
import { SYSTEM_ROLES, PERMISSION_DEFS, permissionKeysForRole } from './rbac-catalog';

export const LOAD_DB_NAME = 'velto_load';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERIFY_SQL_PATH = join(__dirname, '..', 'scripts', 'verify-integrity.sql');
const LOAD_DB_SCRIPT = join(__dirname, '..', 'scripts', 'load-db.sh');
const LONG_TX = { maxWait: 60_000, timeout: 30 * 60_000 };

export type SeedLoadOptions = {
  appUrl: string;
  systemUrl: string;
  slug: string;
  agents: number;
  skus: number;
  outlets: number;
  warehouses: number;
  orders: number;
  chunk: number;
  log?: (msg: string) => void;
};

export type IntegrityFinding = { check_name: string; subject: string; expected: string; actual: string };

export type SeedLoadReport = {
  companyId: string;
  ordersInserted: number;
  seconds: { reference: number; history: number; finalize: number; verify: number; total: number };
  counts: Record<string, number>;
  ordersByStatus: Record<string, number>;
  findings: IntegrityFinding[];
};

/** Fails closed unless the URL points at the velto_load database. */
export function assertLoadDatabaseUrl(url: string | undefined, label: string): string {
  if (!url) throw new Error(`${label}: URL is not set`);
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`${label}: not a valid URL`);
  }
  if (dbName !== LOAD_DB_NAME) {
    throw new Error(`${label}: refusing to write to database "${dbName}" — only "${LOAD_DB_NAME}" is allowed`);
  }
  return url;
}

/** Same URL with the database name swapped to velto_load (credentials/host kept). */
export function toLoadDatabaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = new URL(url);
  u.pathname = `/${LOAD_DB_NAME}`;
  return u.toString();
}

function assertNotProduction() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed load data: NODE_ENV=production.');
  }
}

async function assertConnectedToLoadDb(client: PrismaClient, label: string) {
  const [row] = await client.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  if (row?.db !== LOAD_DB_NAME) {
    throw new Error(`${label}: connected to "${row?.db}", expected "${LOAD_DB_NAME}" — aborting`);
  }
}

type Tx = Prisma.TransactionClient;

/** withTenant() equivalent bound to the velto_load app client (client.ts's is bound to DATABASE_URL). */
function inTenant<T>(client: PrismaClient, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(companyId)) throw new Error(`inTenant: "${companyId}" is not a valid companyId`);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    return fn(tx);
  }, LONG_TX);
}

/** Deterministic pseudo-random int in [0, k) from an SQL expression + salt. */
const h = (expr: string, salt: string, k: number | string) =>
  `(((hashtext((${expr})::text || '${salt}'))::bigint + 2147483648) % (${k}))`;

const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;
const phoneOf = (prefix: string, n: number) => `+99899${prefix}${String(n).padStart(6, '0')}`;
const OWNER_PHONE = phoneOf('0', 1);
const CASHIER_PHONE = phoneOf('0', 4);
const AGENT_PHONE_PREFIX = '1';

function validate(o: SeedLoadOptions) {
  const ints: (keyof SeedLoadOptions)[] = ['agents', 'skus', 'outlets', 'warehouses', 'orders', 'chunk'];
  for (const k of ints) {
    const v = o[k] as number;
    if (!Number.isInteger(v) || v < 1) throw new Error(`--${k} must be a positive integer`);
  }
  if (o.skus < 5) throw new Error('--skus must be >= 5 (an order has up to 5 distinct lines)');
  if (o.outlets < o.agents) throw new Error('--outlets must be >= --agents (every route needs a stop)');
  if (o.orders > 999_999) throw new Error('--orders must fit SO-{YYYY}-{6 digits}');
  if (!SLUG_RE.test(o.slug)) throw new Error('--slug must match ' + SLUG_RE);
}

// ---------------------------------------------------------------------------

export async function seedLoad(opts: SeedLoadOptions): Promise<SeedLoadReport> {
  assertNotProduction();
  validate(opts);
  const log = opts.log ?? (() => {});
  const app = new PrismaClient({ datasources: { db: { url: assertLoadDatabaseUrl(opts.appUrl, 'app URL') } } });
  const sys = new PrismaClient({ datasources: { db: { url: assertLoadDatabaseUrl(opts.systemUrl, 'system URL') } } });
  const t0 = Date.now();
  try {
    await assertConnectedToLoadDb(app, 'app URL');
    await assertConnectedToLoadDb(sys, 'system URL');

    const companyId = await provisionCompany(sys, opts.slug);
    const tRef = Date.now();
    await seedReference(app, sys, companyId, opts, log);
    const tHist = Date.now();
    const ordersInserted = await seedHistory(app, companyId, opts, log);
    const tFin = Date.now();
    await finalize(app, companyId);
    const tVer = Date.now();
    const { findings, counts, ordersByStatus } = await verify(app, companyId);
    const tEnd = Date.now();
    const s = (a: number, b: number) => Math.round((b - a) / 100) / 10;
    return {
      companyId,
      ordersInserted,
      seconds: { reference: s(tRef, tHist), history: s(tHist, tFin), finalize: s(tFin, tVer), verify: s(tVer, tEnd), total: s(t0, tEnd) },
      counts,
      ordersByStatus,
      findings,
    };
  } finally {
    await Promise.all([app.$disconnect(), sys.$disconnect()]);
  }
}

/** Tenant + Company are platform provisioning (BYPASSRLS), as in seed.ts. */
async function provisionCompany(sys: PrismaClient, slug: string): Promise<string> {
  const tenant =
    (await sys.tenant.findUnique({ where: { slug } })) ??
    (await sys.tenant.create({ data: { slug, name: `Load test (${slug})`, plan: 'SCALE' } }));
  const company =
    (await sys.company.findFirst({ where: { tenantId: tenant.id } })) ??
    (await sys.company.create({
      data: { tenantId: tenant.id, name: `Load Savdo (${slug})`, currency: 'UZS', defaultVatRate: 12, timezone: 'Asia/Tashkent' },
    }));
  return company.id;
}

async function seedPermissions(sys: PrismaClient): Promise<Record<string, string>> {
  const idByKey: Record<string, string> = {};
  for (const def of PERMISSION_DEFS) {
    for (const action of def.actions) {
      const p = await sys.permission.upsert({
        where: { module_code: { module: def.module, code: action } },
        update: {},
        create: { module: def.module, code: action },
      });
      idByKey[`${def.module}.${action}`] = p.id;
    }
  }
  return idByKey;
}

/** All reference data in ONE tenant transaction: either fully there (users exist) or absent. */
async function seedReference(app: PrismaClient, sys: PrismaClient, cid: string, o: SeedLoadOptions, log: (m: string) => void) {
  const done = await inTenant(app, cid, (tx) => tx.user.count());
  if (done > 0) {
    log('reference data already present — skipping');
    return;
  }
  const permissionIdByKey = await seedPermissions(sys);
  const password = process.env.SEED_DEMO_PASSWORD;
  const passwordHash = password ? await argon2.hash(password, { type: argon2.argon2id }) : null;

  await inTenant(app, cid, async (tx) => {
    const roleIdByCode: Record<string, string> = {};
    for (const def of SYSTEM_ROLES) {
      roleIdByCode[def.code] = (await tx.role.create({ data: { companyId: cid, code: def.code, name: def.name, isSystem: true } })).id;
    }
    await tx.rolePermission.createMany({
      data: Object.entries(roleIdByCode).flatMap(([code, roleId]) =>
        permissionKeysForRole(code).flatMap((key) => (permissionIdByKey[key] ? [{ roleId, permissionId: permissionIdByKey[key]! }] : [])),
      ),
    });

    const users: { id: string; firstName: string; lastName: string; phone: string; role: string }[] = [
      { id: randomUUID(), firstName: 'Load', lastName: 'Owner', phone: OWNER_PHONE, role: 'OWNER' },
      { id: randomUUID(), firstName: 'Load', lastName: 'Director', phone: phoneOf('0', 2), role: 'SALES_DIRECTOR' },
      { id: randomUUID(), firstName: 'Load', lastName: 'Omborchi', phone: phoneOf('0', 3), role: 'WAREHOUSE' },
      { id: randomUUID(), firstName: 'Load', lastName: 'Kassir', phone: CASHIER_PHONE, role: 'CASHIER' },
      ...Array.from({ length: o.agents }, (_, i) => ({
        id: randomUUID(), firstName: 'Agent', lastName: String(i + 1).padStart(2, '0'),
        phone: phoneOf(AGENT_PHONE_PREFIX, i + 1), role: 'SALES_AGENT',
      })),
    ];
    await tx.user.createMany({
      data: users.map((u) => ({
        id: u.id, companyId: cid, firstName: u.firstName, lastName: u.lastName, phone: u.phone, passwordHash, isActive: true,
      })),
    });
    await tx.userRole.createMany({ data: users.map((u) => ({ userId: u.id, roleId: roleIdByCode[u.role]! })) });

    await tx.warehouse.createMany({
      data: Array.from({ length: o.warehouses }, (_, i) => ({ companyId: cid, name: `Ombor ${String(i + 1).padStart(2, '0')}` })),
    });
    await tx.productCategory.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ companyId: cid, name: `Kategoriya ${String(i + 1).padStart(2, '0')}` })),
    });

    const sql = (s: string) => tx.$executeRawUnsafe(s);
    await sql(`
      INSERT INTO "Product" ("id","companyId","categoryId","sku","barcode","name","brand","baseUnit","vatRate","externalCode","createdAt","updatedAt")
      SELECT gen_random_uuid(), '${cid}', c."id", 'LSKU-' || lpad(g::text, 6, '0'), '29' || lpad(g::text, 11, '0'),
             'Mahsulot ' || g, 'Brend ' || ((g - 1) % 50 + 1), 'dona', 12, 'LSKU-' || lpad(g::text, 6, '0'), ${NOW_UTC}, ${NOW_UTC}
      FROM generate_series(1, ${o.skus}) g
      JOIN "ProductCategory" c ON c."companyId" = '${cid}' AND c."name" = 'Kategoriya ' || lpad(((g - 1) % 10 + 1)::text, 2, '0')`);
    await sql(`
      INSERT INTO "ProductPackaging" ("id","productId","name","qtyInBaseUnit","isDefault","createdAt","updatedAt")
      SELECT gen_random_uuid(), p."id", pk.name, pk.qty, pk.qty = 1, ${NOW_UTC}, ${NOW_UTC}
      FROM "Product" p CROSS JOIN (VALUES ('dona', 1), ('blok', 12), ('quti', 96)) pk(name, qty)
      WHERE p."companyId" = '${cid}'`);
    const priceListId = randomUUID();
    await tx.priceList.create({ data: { id: priceListId, companyId: cid, name: 'Asosiy narx', isDefault: true } });
    await sql(`
      INSERT INTO "PriceListItem" ("id","priceListId","productId","price","createdAt","updatedAt")
      SELECT gen_random_uuid(), '${priceListId}', p."id", 1000 + ${h('p."sku"', 'price', 200)} * 100, ${NOW_UTC}, ${NOW_UTC}
      FROM "Product" p WHERE p."companyId" = '${cid}'`);
    await sql(`
      INSERT INTO "Customer" ("id","companyId","code","name","phone","priceListId","paymentTermDays","createdAt","updatedAt")
      SELECT gen_random_uuid(), '${cid}', 'LC-' || lpad(g::text, 6, '0'), 'Mijoz ' || g || ' MChJ',
             '+99893' || lpad(g::text, 7, '0'), '${priceListId}', (ARRAY[0, 7, 14, 30])[1 + ${h('g', 'term', 4)}], ${NOW_UTC}, ${NOW_UTC}
      FROM generate_series(1, ${o.outlets}) g`);
    await sql(`
      INSERT INTO "Outlet" ("id","companyId","customerId","name","type","address","latitude","longitude","createdAt","updatedAt")
      SELECT gen_random_uuid(), '${cid}', c."id", c."name" || ' do''koni',
             (ARRAY['SHOP','MINIMARKET','SUPERMARKET','BAZAAR'])[1 + ${h('c."code"', 'otype', 4)}]::"OutletType",
             'Toshkent sh.', 41.2995 + (${h('c."code"', 'lat', 16000)} - 8000) / 100000.0,
             69.2401 + (${h('c."code"', 'lng', 16000)} - 8000) / 100000.0, ${NOW_UTC}, ${NOW_UTC}
      FROM "Customer" c WHERE c."companyId" = '${cid}'`);
    // One route per agent; its stops = the outlets that agent sells to below.
    await sql(`
      INSERT INTO "Route" ("id","companyId","agentId","weekday","name","createdAt","updatedAt")
      SELECT gen_random_uuid(), '${cid}', a."id", (a.idx % 6) + 1, 'Marshrut ' || lpad((a.idx + 1)::text, 2, '0'), ${NOW_UTC}, ${NOW_UTC}
      FROM (${agentsSql(cid)}) a`);
    await sql(`
      INSERT INTO "RouteStop" ("id","routeId","outletId","sortOrder","createdAt","updatedAt")
      SELECT gen_random_uuid(), r."id", ou."id", (ou.idx / ${o.agents}) + 1, ${NOW_UTC}, ${NOW_UTC}
      FROM (${outletsSql(cid)}) ou
      JOIN (${agentsSql(cid)}) a ON a.idx = ou.idx % ${o.agents}
      JOIN "Route" r ON r."agentId" = a."id"`);
  });
  log(`reference data: ${o.agents} agents, ${o.skus} SKU, ${o.outlets} outlets, ${o.warehouses} warehouses`);
}

const agentsSql = (cid: string) => `
  SELECT (row_number() OVER (ORDER BY u."phone") - 1)::int AS idx, u."id"
  FROM "User" u WHERE u."companyId" = '${cid}' AND u."phone" LIKE '+99899${AGENT_PHONE_PREFIX}%'`;
const outletsSql = (cid: string) => `
  SELECT (row_number() OVER (ORDER BY c."code") - 1)::int AS idx, o."id", o."customerId"
  FROM "Outlet" o JOIN "Customer" c ON c."id" = o."customerId" WHERE o."companyId" = '${cid}'`;

/** Order timeline: from Jan 1 (or 60 days back) to yesterday 00:00 UTC — stable within a day, so resume is consistent. */
function timeline() {
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 86_400_000;
  const start = Math.min(Date.UTC(today.getUTCFullYear(), 0, 1), end - 60 * 86_400_000);
  return { startEpoch: start / 1000, spanSec: (end - start) / 1000, year: new Date(end).getUTCFullYear() };
}

const CONSUMES = `status IN ('DELIVERED','CLOSED')`;
const RESERVES = `(status IN ('DELIVERED','CLOSED','CONFIRMED') OR cancelled_after_confirm)`;

async function seedHistory(app: PrismaClient, cid: string, o: SeedLoadOptions, log: (m: string) => void): Promise<number> {
  const already = await inTenant(app, cid, (tx) => tx.salesOrder.count());
  const { startEpoch, spanSec, year } = timeline();
  let inserted = 0;
  for (let lo = already + 1; lo <= o.orders; lo += o.chunk) {
    const hi = Math.min(lo + o.chunk - 1, o.orders);
    const t = Date.now();
    await inTenant(app, cid, async (tx) => {
      const sql = (s: string) => tx.$executeRawUnsafe(s);
      await sql(`CREATE TEMP TABLE _ag ON COMMIT DROP AS ${agentsSql(cid)}`);
      await sql(`CREATE TEMP TABLE _ou ON COMMIT DROP AS ${outletsSql(cid)}`);
      await sql(`CREATE TEMP TABLE _wh ON COMMIT DROP AS
        SELECT (row_number() OVER (ORDER BY "name") - 1)::int AS idx, "id" FROM "Warehouse" WHERE "companyId" = '${cid}'`);
      await sql(`CREATE TEMP TABLE _pr ON COMMIT DROP AS
        SELECT (row_number() OVER (ORDER BY p."sku") - 1)::int AS idx, p."id", p."vatRate" AS vat, pli."price",
               d."id" AS dona_id, b."id" AS blok_id
        FROM "Product" p
        JOIN "PriceListItem" pli ON pli."productId" = p."id"
        JOIN "PriceList" pl ON pl."id" = pli."priceListId" AND pl."isDefault"
        JOIN "ProductPackaging" d ON d."productId" = p."id" AND d."qtyInBaseUnit" = 1
        JOIN "ProductPackaging" b ON b."productId" = p."id" AND b."qtyInBaseUnit" = 12
        WHERE p."companyId" = '${cid}'`);

      // Status mix: 78% DELIVERED, 4% CLOSED, 6% CONFIRMED, 4% SUBMITTED,
      // 3% DRAFT, 5% CANCELLED (half of them after confirmation: RESERVE+RELEASE).
      await sql(`CREATE TEMP TABLE _o ON COMMIT DROP AS
        SELECT g.n, gen_random_uuid() AS id, a."id" AS agent_id, ou."id" AS outlet_id, ou."customerId" AS customer_id, w."id" AS wh_id,
          (CASE WHEN g.s < 78 THEN 'DELIVERED' WHEN g.s < 82 THEN 'CLOSED' WHEN g.s < 88 THEN 'CONFIRMED'
                WHEN g.s < 92 THEN 'SUBMITTED' WHEN g.s < 95 THEN 'DRAFT' ELSE 'CANCELLED' END)::"OrderStatus" AS status,
          (g.s >= 95 AND g.n % 2 = 0) AS cancelled_after_confirm,
          to_timestamp(${startEpoch} + (g.n - 1)::float8 * ${spanSec} / ${o.orders} + ${h('g.n', 'sec', 3600)}) AT TIME ZONE 'UTC' AS created_at
        FROM (SELECT n, ${h('n', 'st', 100)} AS s, ${h('n', 'wh', o.warehouses)} AS widx, ${h('n', 'ou', 1_000_000_007)} AS ok
              FROM generate_series(${lo}, ${hi}) n) g
        JOIN _ag a ON a.idx = g.n % ${o.agents}
        JOIN _ou ou ON ou.idx = a.idx + ${o.agents} * (g.ok % (((${o.outlets} - 1 - a.idx) / ${o.agents}) + 1))
        JOIN _wh w ON w.idx = g.widx`);

      // 1–5 distinct products per order; 80% "dona", 20% "blok" (12); 10% lines 5% discount.
      await sql(`CREATE TEMP TABLE _l ON COMMIT DROP AS
        SELECT gen_random_uuid() AS id, o.id AS order_id, o.n, o.status, o.cancelled_after_confirm, o.wh_id, o.created_at,
               p."id" AS product_id, CASE WHEN x.blk THEN p.blok_id ELSE p.dona_id END AS packaging_id,
               x.q AS qty, x.q * CASE WHEN x.blk THEN 12 ELSE 1 END AS base_qty,
               p."price" * CASE WHEN x.blk THEN 12 ELSE 1 END AS unit_price, x.disc, p.vat,
               round(x.q * p."price" * CASE WHEN x.blk THEN 12 ELSE 1 END * (1 - x.disc / 100.0) * (1 + p.vat / 100.0), 2) AS line_total
        FROM _o o
        CROSS JOIN LATERAL generate_series(0, ${h('o.n', 'lc', 5)}) j
        JOIN _pr p ON p.idx = (${h('o.n', 'pr', o.skus)} + j * 7919) % ${o.skus}
        CROSS JOIN LATERAL (SELECT ${h('o.n * 10 + j', 'pk', 100)} < 20 AS blk, 1 + ${h('o.n * 10 + j', 'q', 20)} AS q,
                                   CASE WHEN ${h('o.n * 10 + j', 'ds', 10)} = 0 THEN 5 ELSE 0 END AS disc) x`);

      await sql(`ANALYZE _o, _l`);
      await sql(`INSERT INTO "SalesOrder" ("id","companyId","number","customerId","outletId","agentId","warehouseId","status",
                   "cancelReason","cancelledAt","createdAt","updatedAt")
        SELECT id, '${cid}', 'SO-${year}-' || lpad(n::text, 6, '0'), customer_id, outlet_id, agent_id, wh_id, status,
               CASE WHEN status = 'CANCELLED' THEN 'Mijoz rad etdi (load seed)' END,
               CASE WHEN status = 'CANCELLED' THEN created_at + interval '2 hours' END, created_at, created_at + interval '1 day'
        FROM _o`);
      await sql(`INSERT INTO "SalesOrderLine" ("id","orderId","productId","packagingId","qty","unitPrice","discountPct","vatRate",
                   "lineTotal","deliveredQty","createdAt","updatedAt")
        SELECT id, order_id, product_id, packaging_id, qty, unit_price, disc, vat, line_total,
               CASE WHEN ${CONSUMES} THEN qty ELSE 0 END, created_at, created_at
        FROM _l`);

      // Replenishment before this chunk's reservations: Σ(reserved base qty) +20% +50,
      // dated 1h before the first reservation of that product/warehouse — so
      // neither onHand nor available ever goes negative (no oversell).
      await sql(`INSERT INTO "StockMovement" ("id","companyId","productId","warehouseId","type","qty","refType","note","createdAt")
        SELECT gen_random_uuid(), '${cid}', product_id, wh_id, 'RECEIVE', ceil(SUM(base_qty) * 1.2) + 50,
               'LoadSeedReceipt', 'Sintetik kirim (load seed)', MIN(created_at) - interval '1 hour'
        FROM _l WHERE ${RESERVES} GROUP BY product_id, wh_id`);
      // Mirrors SalesService: confirm = RESERVE; deliver = ISSUE; cancel after confirm = RELEASE.
      await sql(`INSERT INTO "StockMovement" ("id","companyId","productId","warehouseId","type","qty","refType","refId","createdAt")
        SELECT gen_random_uuid(), '${cid}', product_id, wh_id, m.type::"StockMovementType", base_qty, 'SalesOrder', order_id, created_at + m.off
        FROM _l CROSS JOIN (VALUES ('RESERVE', interval '0'), ('ISSUE', interval '1 day'), ('RELEASE', interval '2 hours')) m(type, off)
        WHERE (m.type = 'RESERVE' AND ${RESERVES}) OR (m.type = 'ISSUE' AND ${CONSUMES})
           OR (m.type = 'RELEASE' AND cancelled_after_confirm)`);

      // Invoices for delivered/closed orders + payment plan: 55% full, 20%
      // partial (30–80%), 5% over-payment (+10% → advance), 5% PENDING_HANDOVER,
      // 15% unpaid; CLOSED orders are always fully paid.
      await sql(`CREATE TEMP TABLE _i ON COMMIT DROP AS
        SELECT x.*,
          CASE WHEN x.kind = 'full' THEN x.total WHEN x.kind = 'partial' THEN round(x.total * (30 + ${h('x.n', 'pp', 51)}) / 100.0, 2)
               WHEN x.kind = 'over' THEN round(x.total * 1.1, 2) WHEN x.kind = 'pending' THEN x.total END AS pay_amount
        FROM (
          SELECT gen_random_uuid() AS id, gen_random_uuid() AS payment_id, o.n, o.id AS order_id, o.customer_id, o.agent_id,
                 o.created_at + interval '1 day' AS created_at,
                 t.total,
                 (SELECT COUNT(*) FROM "Invoice" WHERE "companyId" = '${cid}') + row_number() OVER (ORDER BY o.n) AS inv_no,
                 CASE WHEN o.status = 'CLOSED' THEN 'full' ELSE (CASE WHEN r < 55 THEN 'full' WHEN r < 75 THEN 'partial'
                      WHEN r < 80 THEN 'over' WHEN r < 85 THEN 'pending' ELSE 'none' END) END AS kind,
                 (ARRAY['CASH','CASH','CARD','TRANSFER'])[1 + ${h('o.n', 'pm', 4)}]::"PaymentMethod" AS method,
                 LEAST(o.created_at + interval '1 day' * (2 + ${h('o.n', 'pd', 10)}), ${NOW_UTC} - interval '1 hour') AS paid_at
          FROM (SELECT _o.*, ${h('_o.n', 'pay', 100)} AS r FROM _o) o
          JOIN (SELECT order_id, SUM(line_total) AS total FROM _l GROUP BY order_id) t ON t.order_id = o.id
          WHERE o.${CONSUMES}
        ) x`);
      await sql(`ALTER TABLE _i ADD COLUMN alloc numeric, ADD COLUMN pay_no bigint`);
      await sql(`UPDATE _i SET alloc = CASE kind WHEN 'full' THEN total WHEN 'partial' THEN pay_amount WHEN 'over' THEN total ELSE 0 END`);
      await sql(`UPDATE _i SET pay_no = s.pay_no FROM (
          SELECT id, (SELECT COUNT(*) FROM "Payment" WHERE "companyId" = '${cid}') + row_number() OVER (ORDER BY n) AS pay_no
          FROM _i WHERE pay_amount IS NOT NULL) s WHERE s.id = _i.id`);

      await sql(`INSERT INTO "Invoice" ("id","companyId","number","customerId","orderId","total","status","createdAt","updatedAt")
        SELECT id, '${cid}', 'INV-${year}-' || lpad(inv_no::text, 6, '0'), customer_id, order_id, total,
               (CASE WHEN alloc >= total THEN 'PAID' WHEN alloc > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END)::"InvoiceStatus",
               created_at, GREATEST(created_at, COALESCE(paid_at, created_at))
        FROM _i`);
      await sql(`INSERT INTO "InvoiceLine" ("id","invoiceId","productId","qty","unitPrice","vatRate","lineTotal","createdAt","updatedAt")
        SELECT gen_random_uuid(), i.id, l.product_id, l.qty, l.unit_price, l.vat, l.line_total, i.created_at, i.created_at
        FROM _i i JOIN _l l ON l.order_id = i.order_id`);
      await sql(`INSERT INTO "Payment" ("id","companyId","number","customerId","amount","method","status","collectedBy","createdAt","updatedAt")
        SELECT payment_id, '${cid}', 'PAY-${year}-' || lpad(pay_no::text, 6, '0'), customer_id, pay_amount, method,
               (CASE WHEN kind = 'pending' THEN 'PENDING_HANDOVER' ELSE 'POSTED' END)::"PaymentStatus", agent_id, paid_at, paid_at
        FROM _i WHERE pay_amount IS NOT NULL`);
      await sql(`INSERT INTO "PaymentAllocation" ("id","paymentId","invoiceId","amount","createdAt")
        SELECT gen_random_uuid(), payment_id, id, alloc, paid_at FROM _i WHERE alloc > 0`);
    });
    inserted += hi - lo + 1;
    log(`orders ${lo}..${hi} committed in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  return inserted;
}

/** Projections rebuilt from the ledgers + counters + cash shifts. Idempotent. */
async function finalize(app: PrismaClient, cid: string) {
  const { startEpoch, spanSec, year } = timeline();
  await inTenant(app, cid, async (tx) => {
    const sql = (s: string) => tx.$executeRawUnsafe(s);
    // StockLevel = Σ StockMovement (the reconciliation formula, F2.5).
    await sql(`INSERT INTO "StockLevel" ("productId","warehouseId","onHand","reserved","createdAt","updatedAt")
      SELECT "productId", "warehouseId",
        COALESCE(SUM(CASE WHEN "type" IN ('RECEIVE','ADJUST') THEN "qty" WHEN "type" = 'ISSUE' THEN -"qty" ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN "type" = 'RESERVE' THEN "qty" WHEN "type" IN ('RELEASE','ISSUE') THEN -"qty" ELSE 0 END), 0),
        ${NOW_UTC}, ${NOW_UTC}
      FROM "StockMovement" WHERE "companyId" = '${cid}' GROUP BY "productId", "warehouseId"
      ON CONFLICT ("productId","warehouseId") DO UPDATE
        SET "onHand" = EXCLUDED."onHand", "reserved" = EXCLUDED."reserved", "updatedAt" = EXCLUDED."updatedAt"
        WHERE "StockLevel"."onHand" <> EXCLUDED."onHand" OR "StockLevel"."reserved" <> EXCLUDED."reserved"`);
    // cachedBalance = getLedger() formula (customers.service.ts, §6.5).
    await sql(`UPDATE "Customer" c SET "cachedBalance" = led.balance, "updatedAt" = ${NOW_UTC}
      FROM (
        SELECT cu."id",
          COALESCE((SELECT SUM(i."total") FROM "Invoice" i WHERE i."customerId" = cu."id" AND i."status" <> 'CANCELLED'), 0)
          - COALESCE((SELECT SUM(pa."amount") FROM "PaymentAllocation" pa
                      JOIN "Invoice" i ON i."id" = pa."invoiceId" AND i."status" <> 'CANCELLED'
                      JOIN "Payment" p ON p."id" = pa."paymentId" AND p."status" = 'POSTED'
                      WHERE i."customerId" = cu."id"), 0)
          - (COALESCE((SELECT SUM(p."amount") FROM "Payment" p WHERE p."customerId" = cu."id" AND p."status" = 'POSTED'), 0)
             - COALESCE((SELECT SUM(pa."amount") FROM "PaymentAllocation" pa
                         JOIN "Payment" p ON p."id" = pa."paymentId" AND p."status" = 'POSTED'
                         JOIN "Invoice" i ON i."id" = pa."invoiceId" AND i."status" <> 'CANCELLED'
                         WHERE p."customerId" = cu."id"), 0)) AS balance
        FROM "Customer" cu WHERE cu."companyId" = '${cid}'
      ) led
      WHERE c."id" = led."id" AND c."cachedBalance" <> led.balance`);
    // One cashier shift per day over the timeline; every day closed except the last.
    const cashier = await tx.user.findFirst({ where: { phone: CASHIER_PHONE }, select: { id: true } });
    if (cashier && (await tx.cashSession.count()) === 0) {
      await sql(`INSERT INTO "CashSession" ("id","companyId","userId","openedAt","closedAt","openAmount","closeAmount","createdAt","updatedAt")
        SELECT gen_random_uuid(), '${cid}', '${cashier.id}', d.day + interval '9 hours',
               CASE WHEN d.day < last.day THEN d.day + interval '18 hours' END, 0,
               CASE WHEN d.day < last.day THEN COALESCE(cash.total, 0) END, d.day + interval '9 hours', d.day + interval '18 hours'
        FROM generate_series(to_timestamp(${startEpoch}) AT TIME ZONE 'UTC', to_timestamp(${startEpoch + spanSec}) AT TIME ZONE 'UTC', interval '1 day') d(day)
        CROSS JOIN (SELECT to_timestamp(${startEpoch + spanSec}) AT TIME ZONE 'UTC' AS day) last
        LEFT JOIN (SELECT date_trunc('day', "createdAt") AS day, SUM("amount") AS total FROM "Payment"
                   WHERE "companyId" = '${cid}' AND "method" = 'CASH' AND "status" = 'POSTED' GROUP BY 1) cash ON cash.day = d.day`);
    }
    // Keep DocumentCounter in step so API-created documents continue the sequence (as seed.ts).
    for (const [docType, count] of [
      ['SO', await tx.salesOrder.count()],
      ['INV', await tx.invoice.count()],
      ['PAY', await tx.payment.count()],
    ] as const) {
      await tx.documentCounter.upsert({
        where: { companyId_docType_year: { companyId: cid, docType, year } },
        update: { lastNumber: count },
        create: { companyId: cid, docType, year, lastNumber: count },
      });
    }
  });
}

/** Runs scripts/verify-integrity.sql through the RLS-bound role, scoped to this company. */
async function verify(app: PrismaClient, cid: string) {
  const verifySql = readFileSync(VERIFY_SQL_PATH, 'utf8').trim().replace(/;\s*$/, '');
  return inTenant(app, cid, async (tx) => {
    const findings = await tx.$queryRawUnsafe<IntegrityFinding[]>(verifySql);
    const counts: Record<string, number> = {
      agents: await tx.userRole.count({ where: { role: { code: 'SALES_AGENT' } } }),
      routes: await tx.route.count(),
      routeStops: await tx.routeStop.count(),
      products: await tx.product.count(),
      warehouses: await tx.warehouse.count(),
      customers: await tx.customer.count(),
      outlets: await tx.outlet.count(),
      salesOrders: await tx.salesOrder.count(),
      salesOrderLines: await tx.salesOrderLine.count(),
      invoices: await tx.invoice.count(),
      invoiceLines: await tx.invoiceLine.count(),
      payments: await tx.payment.count(),
      paymentAllocations: await tx.paymentAllocation.count(),
      stockMovements: await tx.stockMovement.count(),
      stockLevels: await tx.stockLevel.count(),
      cashSessions: await tx.cashSession.count(),
    };
    const byStatus = await tx.salesOrder.groupBy({ by: ['status'], _count: { _all: true } });
    const ordersByStatus = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
    return { findings, counts, ordersByStatus };
  });
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unknown argument: ${a}`);
    args.set(m[1]!, m[2] ?? 'true');
  }
  const int = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
  return {
    reset: args.get('reset') === 'true',
    opts: {
      appUrl: args.get('url') ?? process.env.DATABASE_LOAD_URL ?? toLoadDatabaseUrl(process.env.DATABASE_URL) ?? '',
      systemUrl: args.get('system-url') ?? process.env.DATABASE_LOAD_SYSTEM_URL ?? toLoadDatabaseUrl(process.env.DATABASE_SYSTEM_URL) ?? '',
      slug: args.get('slug') ?? 'load',
      agents: int('agents', 20),
      skus: int('skus', 2000),
      outlets: int('outlets', 1000),
      warehouses: int('warehouses', 3),
      orders: int('orders', 100_000),
      chunk: int('chunk', 10_000),
      log: (m: string) => console.log(`[seed-load] ${m}`),
    } satisfies SeedLoadOptions,
  };
}

async function cli() {
  assertNotProduction();
  const { reset, opts } = parseArgs(process.argv.slice(2));
  assertLoadDatabaseUrl(opts.appUrl, 'app URL');
  assertLoadDatabaseUrl(opts.systemUrl, 'system URL');
  if (reset) {
    // Append-only ledgers can't be deleted row-wise: drop + recreate velto_load.
    const r = spawnSync('bash', [LOAD_DB_SCRIPT, 'reset'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('load-db.sh reset failed');
  }
  const report = await seedLoad(opts);
  console.log(JSON.stringify({ ...report, findings: report.findings.length, firstFindings: report.findings.slice(0, 10) }, null, 2));
  if (report.findings.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  cli().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
