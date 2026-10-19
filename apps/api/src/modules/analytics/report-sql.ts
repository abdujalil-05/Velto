import { DELIVERY_PRICED_STATUSES } from '../sales/line-total';
import { Prisma, type TenantClient } from '@velto/database';
import { COUNTED_ORDER_STATUSES } from './report-utils';

/**
 * DB-side aggregation for the sales reports (F7 load finding: loading every
 * order into Node blew the bind limit / tx timeout). Same rule as
 * `orderTotal` (§6.6/F2.4): DELIVERED/CLOSED -> delivered line amount (full
 * delivery keeps the snapshot lineTotal, partial is recomputed and rounded
 * once HALF_UP to 2dp), any other status -> ordered snapshot lineTotal.
 * Only enum constants are inlined (Prisma.raw); every value is a bound param.
 */
const statusList = (statuses: readonly string[]) => Prisma.raw(statuses.map((s) => `'${s}'`).join(','));

const COUNTED = statusList(COUNTED_ORDER_STATUSES);
const DELIVERY_PRICED = statusList(DELIVERY_PRICED_STATUSES);

/** SQL expression: one line's effective amount (alias `o` = SalesOrder, `l` = SalesOrderLine). */
export const LINE_AMOUNT_SQL = Prisma.sql`(CASE WHEN o."status" IN (${DELIVERY_PRICED}) AND l."deliveredQty" <> l."qty"
  THEN ROUND(l."deliveredQty" * l."unitPrice" * (1 - l."discountPct" / 100) * (1 + l."vatRate" / 100), 2)
  ELSE l."lineTotal" END)`;

/** Counted orders of the window with their amount: columns id, createdAt, agentId, customerId, total. */
export function countedOrderTotalsSql(start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`SELECT o."id", o."createdAt", o."agentId", o."customerId", COALESCE(SUM(${LINE_AMOUNT_SQL}), 0) AS "total"
    FROM "SalesOrder" o LEFT JOIN "SalesOrderLine" l ON l."orderId" = o."id"
    WHERE o."createdAt" >= ${start} AND o."createdAt" <= ${end} AND o."status" IN (${COUNTED})
    GROUP BY o."id"`;
}

/** `YYYY-MM-DD` of the company-timezone day (createdAt is a UTC timestamp without zone). */
export function localDaySql(column: Prisma.Sql, timeZone: string): Prisma.Sql {
  return Prisma.sql`to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;
}

const dec = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);

export async function orderTotalsInWindow(tx: TenantClient, start: Date, end: Date) {
  const rows = await tx.$queryRaw<{ turnover: Prisma.Decimal; count: number; customers: number }[]>`
    SELECT COALESCE(SUM(t."total"), 0) AS "turnover", COUNT(*)::int AS "count", COUNT(DISTINCT t."customerId")::int AS "customers"
    FROM (${countedOrderTotalsSql(start, end)}) t`;
  return { turnover: dec(rows[0]?.turnover), count: rows[0]?.count ?? 0, activeCustomers: rows[0]?.customers ?? 0 };
}

export async function turnoverPerDay(tx: TenantClient, start: Date, end: Date, timeZone: string) {
  const rows = await tx.$queryRaw<{ day: string; turnover: Prisma.Decimal; count: number }[]>`
    SELECT ${localDaySql(Prisma.sql`t."createdAt"`, timeZone)} AS "day", SUM(t."total") AS "turnover", COUNT(*)::int AS "count"
    FROM (${countedOrderTotalsSql(start, end)}) t GROUP BY 1`;
  return new Map(rows.map((r) => [r.day, { turnover: dec(r.turnover), count: r.count }]));
}

/** Per agent (orders with agentId only): turnover and order count. */
export async function turnoverPerAgent(tx: TenantClient, start: Date, end: Date, agentIds?: string[]) {
  const filter = agentIds ? Prisma.sql`AND t."agentId" IN (${Prisma.join(agentIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
  const rows = await tx.$queryRaw<{ agentId: string; turnover: Prisma.Decimal; count: number }[]>`
    SELECT t."agentId", SUM(t."total") AS "turnover", COUNT(*)::int AS "count"
    FROM (${countedOrderTotalsSql(start, end)}) t WHERE t."agentId" IS NOT NULL ${filter} GROUP BY t."agentId"`;
  return rows.map((r) => ({ agentId: r.agentId, turnover: dec(r.turnover), count: r.count }));
}

export async function topProductsInWindow(tx: TenantClient, start: Date, end: Date, limit: number) {
  const rows = await tx.$queryRaw<{ productId: string; name: string; turnover: Prisma.Decimal }[]>`
    SELECT l."productId", p."name", SUM(${LINE_AMOUNT_SQL}) AS "turnover"
    FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o."id" JOIN "Product" p ON p."id" = l."productId"
    WHERE o."createdAt" >= ${start} AND o."createdAt" <= ${end} AND o."status" IN (${COUNTED})
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
