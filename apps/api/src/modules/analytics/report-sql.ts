import { Prisma, type TenantClient } from '@velto/database';
import { TURNOVER_STATUSES } from './report-utils';

/**
 * DB-side aggregation for the sales reports (F7 load finding: loading every
 * order into Node blew the bind limit / tx timeout). Turnover rule (F2.4, PO
 * 2026-11-01): only TURNOVER_STATUSES (DELIVERED/CLOSED) orders, at their
 * delivered amount — same value as `deliveredLineTotal`/invoice line (full
 * delivery keeps the snapshot lineTotal, partial is recomputed from
 * deliveredQty and rounded once HALF_UP to 2dp).
 * Only enum constants are inlined (Prisma.raw); every value is a bound param.
 */
const statusList = (statuses: readonly string[]) => Prisma.raw(statuses.map((s) => `'${s}'`).join(','));

const TURNOVER = statusList(TURNOVER_STATUSES);

/**
 * SQL expression: one line's DELIVERED amount (alias `o` = SalesOrder, `l` = SalesOrderLine).
 * Only valid together with the `o."status" IN (TURNOVER)` filter below.
 */
export const LINE_AMOUNT_SQL = Prisma.sql`(CASE WHEN l."deliveredQty" <> l."qty"
  THEN ROUND(l."deliveredQty" * l."unitPrice" * (1 - l."discountPct" / 100) * (1 + l."vatRate" / 100), 2)
  ELSE l."lineTotal" END)`;

/**
 * Turnover date (PO 2026-11-01): the actual confirmed delivery = the order's
 * SALE invoice createdAt (written in the same tx as status DELIVERED by
 * SalesService.deliver()). Pre-aggregated per order (GROUP BY orderId, MIN) so
 * an order with >1 SALE invoice still yields one row, dated by the earliest;
 * one hash-join scan instead of a per-order correlated lookup (Invoice has no
 * orderId index). INNER JOIN: an order with no SALE invoice is excluded (no
 * fallback to SalesOrder.createdAt/updatedAt). OPENING invoices (orderId NULL,
 * kind OPENING) never match. Window filter in HAVING; alias `d`, join on `o`.
 */
const deliveredInWindowJoin = (start: Date, end: Date) => Prisma.sql`JOIN (
    SELECT i."orderId", MIN(i."createdAt") AS "turnoverAt" FROM "Invoice" i
    WHERE i."kind" = 'SALE' AND i."orderId" IS NOT NULL
    GROUP BY i."orderId" HAVING MIN(i."createdAt") >= ${start} AND MIN(i."createdAt") <= ${end}
  ) d ON d."orderId" = o."id"`;

/**
 * Delivered (turnover) orders of the window with their delivered amount:
 * columns id, turnoverAt, agentId, customerId, total. COUNT(*) over it is the
 * delivered-order count. Window and day bucket = turnoverAt (delivery date).
 */
export function countedOrderTotalsSql(start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`SELECT o."id", d."turnoverAt", o."agentId", o."customerId", COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) AS "total"
    FROM "SalesOrder" o ${deliveredInWindowJoin(start, end)} LEFT JOIN "SalesOrderLine" l ON l."orderId" = o."id"
    WHERE o."status" IN (${TURNOVER})
    GROUP BY o."id", d."turnoverAt"`;
}

/** `YYYY-MM-DD` of the company-timezone day (column is a UTC timestamp without zone). */
export function localDaySql(column: Prisma.Sql, timeZone: string): Prisma.Sql {
  return Prisma.sql`to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;
}

const dec = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);

/** Window totals: delivered turnover, delivered-order count (API `orderCount`), distinct customers of delivered orders. */
export async function orderTotalsInWindow(tx: TenantClient, start: Date, end: Date) {
  const rows = await tx.$queryRaw<{ turnover: Prisma.Decimal; count: number; customers: number }[]>`
    SELECT COALESCE(SUM(t."total"), 0) AS "turnover", COUNT(*)::int AS "count", COUNT(DISTINCT t."customerId")::int AS "customers"
    FROM (${countedOrderTotalsSql(start, end)}) t`;
  return { turnover: dec(rows[0]?.turnover), deliveredOrderCount: rows[0]?.count ?? 0, activeCustomers: rows[0]?.customers ?? 0 };
}

export async function turnoverPerDay(tx: TenantClient, start: Date, end: Date, timeZone: string) {
  const rows = await tx.$queryRaw<{ day: string; turnover: Prisma.Decimal; count: number }[]>`
    SELECT ${localDaySql(Prisma.sql`t."turnoverAt"`, timeZone)} AS "day", SUM(t."total") AS "turnover", COUNT(*)::int AS "count"
    FROM (${countedOrderTotalsSql(start, end)}) t GROUP BY 1`;
  return new Map(rows.map((r) => [r.day, { turnover: dec(r.turnover), deliveredOrderCount: r.count }]));
}

/** Per agent (orders with agentId only): delivered turnover and delivered-order count. */
export async function turnoverPerAgent(tx: TenantClient, start: Date, end: Date, agentIds?: string[]) {
  const filter = agentIds ? Prisma.sql`AND t."agentId" IN (${Prisma.join(agentIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
  const rows = await tx.$queryRaw<{ agentId: string; turnover: Prisma.Decimal; count: number }[]>`
    SELECT t."agentId", SUM(t."total") AS "turnover", COUNT(*)::int AS "count"
    FROM (${countedOrderTotalsSql(start, end)}) t WHERE t."agentId" IS NOT NULL ${filter} GROUP BY t."agentId"`;
  return rows.map((r) => ({ agentId: r.agentId, turnover: dec(r.turnover), deliveredOrderCount: r.count }));
}

export async function topProductsInWindow(tx: TenantClient, start: Date, end: Date, limit: number) {
  const rows = await tx.$queryRaw<{ productId: string; name: string; turnover: Prisma.Decimal }[]>`
    SELECT l."productId", p."name", SUM(${LINE_AMOUNT_SQL}) AS "turnover"
    FROM "SalesOrder" o ${deliveredInWindowJoin(start, end)}
    JOIN "SalesOrderLine" l ON l."orderId" = o."id" JOIN "Product" p ON p."id" = l."productId"
    WHERE o."status" IN (${TURNOVER})
    GROUP BY l."productId", p."name" ORDER BY SUM(${LINE_AMOUNT_SQL}) DESC, l."productId" LIMIT ${limit}`;
  return rows.map((r) => ({ productId: r.productId, productName: r.name, turnover: dec(r.turnover) }));
}

/**
 * Outstanding invoice debt. `asOf` mode (dashboard "vs yesterday"): invoices
 * created by asOf, not CANCELLED, allocations of POSTED payments posted by
 * asOf, overdue at asOf. `open` mode (overview): OPEN/PARTIALLY_PAID, all
 * POSTED allocations, overdue now. OPENING invoices belong to both (balance/aging).
 */
export async function invoiceDebt(
  tx: TenantClient,
  mode: { kind: 'asOf'; asOf: Date } | { kind: 'open'; now: Date },
): Promise<{ total: Prisma.Decimal; overdue: Prisma.Decimal }> {
  const at = mode.kind === 'asOf' ? mode.asOf : mode.now;
  const invoiceFilter =
    mode.kind === 'asOf'
      ? Prisma.sql`i."createdAt" <= ${at} AND i."status" <> 'CANCELLED'`
      : Prisma.sql`i."status" IN ('OPEN', 'PARTIALLY_PAID')`;
  const allocFilter =
    mode.kind === 'asOf' ? Prisma.sql`AND COALESCE(p."handoverAt", p."createdAt") <= ${at}` : Prisma.empty;
  const rows = await tx.$queryRaw<{ total: Prisma.Decimal; overdue: Prisma.Decimal }[]>`
    SELECT COALESCE(SUM(x."outstanding"), 0) AS "total",
           COALESCE(SUM(x."outstanding") FILTER (WHERE x."dueAt" < ${at}), 0) AS "overdue"
    FROM (
      SELECT i."total" - COALESCE(pa."paid", 0) AS "outstanding",
             i."createdAt" + c."paymentTermDays" * interval '1 day' AS "dueAt"
      FROM "Invoice" i
      JOIN "Customer" c ON c."id" = i."customerId"
      LEFT JOIN (
        SELECT a."invoiceId", SUM(a."amount") AS "paid"
        FROM "PaymentAllocation" a JOIN "Payment" p ON p."id" = a."paymentId"
        WHERE p."status" = 'POSTED' ${allocFilter}
        GROUP BY a."invoiceId"
      ) pa ON pa."invoiceId" = i."id"
      WHERE ${invoiceFilter}
    ) x WHERE x."outstanding" > 0`;
  return { total: dec(rows[0]?.total), overdue: dec(rows[0]?.overdue) };
}

/**
 * `invoiceDebt` in `asOf` mode for several points in time in ONE scan of
 * Invoice/PaymentAllocation (dashboard: now + yesterday end). Result k equals
 * `invoiceDebt(tx, { kind: 'asOf', asOf: asOfs[k] })` exactly.
 */
export async function invoiceDebtAsOfMany(
  tx: TenantClient,
  asOfs: Date[],
): Promise<{ total: Prisma.Decimal; overdue: Prisma.Decimal }[]> {
  if (asOfs.length === 0) return [];
  const latest = new Date(Math.max(...asOfs.map((d) => d.getTime())));
  const paidCols = Prisma.join(
    asOfs.map((at, k) => Prisma.sql`SUM(a."amount") FILTER (WHERE COALESCE(p."handoverAt", p."createdAt") <= ${at}) AS ${Prisma.raw(`"paid${k}"`)}`),
  );
  const outCols = Prisma.join(
    asOfs.map(
      (at, k) =>
        Prisma.sql`(CASE WHEN i."createdAt" <= ${at} THEN i."total" - COALESCE(pa.${Prisma.raw(`"paid${k}"`)}, 0) END) AS ${Prisma.raw(`"out${k}"`)}`,
    ),
  );
  const sumCols = Prisma.join(
    asOfs.flatMap((at, k) => {
      const o = Prisma.raw(`x."out${k}"`);
      return [
        Prisma.sql`COALESCE(SUM(${o}) FILTER (WHERE ${o} > 0), 0) AS ${Prisma.raw(`"total${k}"`)}`,
        Prisma.sql`COALESCE(SUM(${o}) FILTER (WHERE ${o} > 0 AND x."dueAt" < ${at}), 0) AS ${Prisma.raw(`"overdue${k}"`)}`,
      ];
    }),
  );
  const rows = await tx.$queryRaw<Record<string, Prisma.Decimal>[]>`
    SELECT ${sumCols}
    FROM (
      SELECT ${outCols}, i."createdAt" + c."paymentTermDays" * interval '1 day' AS "dueAt"
      FROM "Invoice" i
      JOIN "Customer" c ON c."id" = i."customerId"
      LEFT JOIN (
        SELECT a."invoiceId", ${paidCols}
        FROM "PaymentAllocation" a JOIN "Payment" p ON p."id" = a."paymentId"
        WHERE p."status" = 'POSTED'
        GROUP BY a."invoiceId"
      ) pa ON pa."invoiceId" = i."id"
      WHERE i."createdAt" <= ${latest} AND i."status" <> 'CANCELLED'
    ) x`;
  const row = rows[0] ?? {};
  return asOfs.map((_, k) => ({ total: dec(row[`total${k}`]), overdue: dec(row[`overdue${k}`]) }));
}
