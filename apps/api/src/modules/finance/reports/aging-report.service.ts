import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { companyDay } from '../../field/company-day';
import { companyTimeZone, DEFAULT_TIME_ZONE } from '../../analytics/report-utils';

/** TZ §6.5 default buckets: muddati kelmagan, 1–7, 8–30, 31–60, 60+ (i.e. 61 and more) days past due. */
export interface AgingBuckets {
  current: Prisma.Decimal;
  d1to7: Prisma.Decimal;
  d8to30: Prisma.Decimal;
  d31to60: Prisma.Decimal;
  d60plus: Prisma.Decimal;
}

export interface AgingRow {
  customerId: string;
  customerName: string;
  buckets: AgingBuckets;
  total: Prisma.Decimal;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant in the company timezone. */
export function companyDate(at: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return companyDay(at, timeZone).date;
}

/** Day index of a YYYY-MM-DD calendar date — pure calendar arithmetic, no clock/DST involved. */
function dayIndex(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/**
 * Calendar days past due as of `asOf` (TZ §6.5 "kalendar farqi aniq belgilanadi"):
 * due date = company-timezone calendar day of Invoice.createdAt + Customer.paymentTermDays;
 * 0 or negative = not yet overdue (due today counts as "muddati kelmagan").
 */
export function daysPastDue(invoiceCreatedAt: Date, paymentTermDays: number, asOf: string, timeZone: string = DEFAULT_TIME_ZONE): number {
  return dayIndex(asOf) - (dayIndex(companyDate(invoiceCreatedAt, timeZone)) + paymentTermDays);
}

export function bucketFor(days: number): keyof AgingBuckets {
  if (days <= 0) return 'current';
  if (days <= 7) return 'd1to7';
  if (days <= 30) return 'd8to30';
  if (days <= 60) return 'd31to60';
  return 'd60plus';
}

@Injectable()
export class AgingReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * 3.1 / 9.2 "/receivables": debt aged into 5 buckets as of `asOf`, one row
   * per customer with an outstanding balance, sorted by total descending.
   */
  async getAging(query: { page: number; pageSize: number; asOf?: string }) {
    const timeZone = await companyTimeZone(this.tenantPrisma.client);
    const asOf = query.asOf ?? companyDate(new Date(), timeZone);
    const rows = await this.computeRows(asOf, timeZone);
    const start = (query.page - 1) * query.pageSize;
    const data = rows.slice(start, start + query.pageSize);
    return { ...paginate(data, rows.length, query.page, query.pageSize), asOf, timeZone };
  }

  /**
   * 9.3 dashboard "top 10 qarzdor": the same rows/order as `/receivables`
   * (total desc, name, customerId) but cut in SQL, so only `limit` rows reach Node.
   * Caller supplies asOf/timeZone it already resolved (no extra round trip).
   */
  async topDebtors(asOf: string, timeZone: string, limit: number): Promise<AgingRow[]> {
    return this.computeRows(asOf, timeZone, limit);
  }

  /** 9.1 "Excel eksport" needs every indebted customer, not just one page — same rows/asOf as the screen. */
  async getAllRows(asOfInput?: string): Promise<{ asOf: string; timeZone: string; rows: AgingRow[] }> {
    const timeZone = await companyTimeZone(this.tenantPrisma.client);
    const asOf = asOfInput ?? companyDate(new Date(), timeZone);
    return { asOf, timeZone, rows: await this.computeRows(asOf, timeZone) };
  }

  /**
   * Aging computed in the DB (F7: loading every invoice + allocation into
   * Node took ~55 s on 83k invoices). Same rules as before: CANCELLED excluded;
   * invoices issued after asOf excluded; an allocation counts when made on/before
   * asOf (company-timezone calendar day) and its payment was not reversed on/before asOf;
   * due day = company-timezone day of createdAt + paymentTermDays; days past due <= 0 = current.
   * Single builder for /receivables, export and the dashboard; `limit` only
   * appends LIMIT to the same ORDER BY (identical ordering and tie-break).
   */
  private async computeRows(asOf: string, timeZone: string, limit?: number): Promise<AgingRow[]> {
    const tx = this.tenantPrisma.client;
    const local = (col: Prisma.Sql) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::date`;
    const asOfDate = Prisma.sql`${asOf}::date`;

    const rows = await tx.$queryRaw<
      { customerId: string; name: string; current: Prisma.Decimal; d1to7: Prisma.Decimal; d8to30: Prisma.Decimal; d31to60: Prisma.Decimal; d60plus: Prisma.Decimal; total: Prisma.Decimal }[]
    >`
      SELECT x."customerId", x."name",
        COALESCE(SUM(x."outstanding") FILTER (WHERE x."days" <= 0), 0) AS "current",
        COALESCE(SUM(x."outstanding") FILTER (WHERE x."days" BETWEEN 1 AND 7), 0) AS "d1to7",
        COALESCE(SUM(x."outstanding") FILTER (WHERE x."days" BETWEEN 8 AND 30), 0) AS "d8to30",
        COALESCE(SUM(x."outstanding") FILTER (WHERE x."days" BETWEEN 31 AND 60), 0) AS "d31to60",
        COALESCE(SUM(x."outstanding") FILTER (WHERE x."days" > 60), 0) AS "d60plus",
        SUM(x."outstanding") AS "total"
      FROM (
        SELECT i."customerId", c."name",
          i."total" - COALESCE(SUM(a."amount") FILTER (WHERE a."id" IS NOT NULL
            AND ${local(Prisma.sql`a."createdAt"`)} <= ${asOfDate}
            AND NOT (p."status" = 'REVERSED' AND (r."id" IS NULL OR ${local(Prisma.sql`r."createdAt"`)} <= ${asOfDate}))), 0) AS "outstanding",
          (${asOfDate} - (${local(Prisma.sql`i."createdAt"`)} + c."paymentTermDays")) AS "days"
        FROM "Invoice" i
        JOIN "Customer" c ON c."id" = i."customerId"
        LEFT JOIN "PaymentAllocation" a ON a."invoiceId" = i."id"
        LEFT JOIN "Payment" p ON p."id" = a."paymentId"
        LEFT JOIN "PaymentReversal" r ON r."reversesPaymentId" = p."id"
        WHERE i."status" <> 'CANCELLED' AND ${local(Prisma.sql`i."createdAt"`)} <= ${asOfDate}
        GROUP BY i."id", c."id"
      ) x
      WHERE x."outstanding" > 0
      GROUP BY x."customerId", x."name"
      ORDER BY SUM(x."outstanding") DESC, x."name", x."customerId"
      ${limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}`;

    return rows.map((r) => ({
      customerId: r.customerId,
      customerName: r.name,
      buckets: {
        current: new Prisma.Decimal(r.current),
        d1to7: new Prisma.Decimal(r.d1to7),
        d8to30: new Prisma.Decimal(r.d8to30),
        d31to60: new Prisma.Decimal(r.d31to60),
        d60plus: new Prisma.Decimal(r.d60plus),
      },
      total: new Prisma.Decimal(r.total),
    }));
  }
}
