import { Injectable } from '@nestjs/common';
import { InvoiceStatus, PaymentStatus, Prisma } from '@velto/database';
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
   * per customer with an outstanding balance, sorted by total descending
   * (reused for the dashboard's "top 10 qarzdor" list via pageSize=10).
   */
  async getAging(query: { page: number; pageSize: number; asOf?: string }) {
    const timeZone = await companyTimeZone(this.tenantPrisma.client);
    const asOf = query.asOf ?? companyDate(new Date(), timeZone);
    const rows = await this.computeRows(asOf, timeZone);
    const start = (query.page - 1) * query.pageSize;
    const data = rows.slice(start, start + query.pageSize);
    return { ...paginate(data, rows.length, query.page, query.pageSize), asOf, timeZone };
  }

  /** 9.1 "Excel eksport" needs every indebted customer, not just one page — same rows/asOf as the screen. */
  async getAllRows(asOfInput?: string): Promise<{ asOf: string; timeZone: string; rows: AgingRow[] }> {
    const timeZone = await companyTimeZone(this.tenantPrisma.client);
    const asOf = asOfInput ?? companyDate(new Date(), timeZone);
    return { asOf, timeZone, rows: await this.computeRows(asOf, timeZone) };
  }

  private async computeRows(asOf: string, timeZone: string): Promise<AgingRow[]> {
    const tx = this.tenantPrisma.client;

    // PAID invoices are included on purpose: as of a past date they may still
    // have been open, and a later payment reversal can re-open them. CANCELLED
    // has no cancellation timestamp, so it is excluded for every asOf.
    const invoices = await tx.invoice.findMany({
      where: { status: { not: InvoiceStatus.CANCELLED } },
      include: {
        allocations: {
          include: { payment: { select: { status: true, reversal: { select: { createdAt: true } } } } },
        },
        customer: { select: { id: true, name: true, paymentTermDays: true } },
      },
    });

    const byCustomer = new Map<string, AgingRow>();

    for (const invoice of invoices) {
      if (companyDate(invoice.createdAt, timeZone) > asOf) continue; // not issued yet on asOf

      // §6.5 "valid allocations": made on/before asOf and not reversed on/before asOf.
      const allocated = invoice.allocations.reduce((sum, a) => {
        if (companyDate(a.createdAt, timeZone) > asOf) return sum;
        const p = a.payment;
        if (p.status === PaymentStatus.REVERSED) {
          // Reversed with no reversal row cannot happen (DB trigger); treat as reversed (safest: debt shown).
          if (!p.reversal || companyDate(p.reversal.createdAt, timeZone) <= asOf) return sum;
        }
        return sum.plus(a.amount);
      }, new Prisma.Decimal(0));
      const outstanding = invoice.total.minus(allocated);
      // Decimal.isPositive() is true for zero too — explicit > 0 excludes settled invoices.
      if (!outstanding.greaterThan(0)) continue;

      let entry = byCustomer.get(invoice.customerId);
      if (!entry) {
        entry = {
          customerId: invoice.customerId,
          customerName: invoice.customer.name,
          buckets: {
            current: new Prisma.Decimal(0),
            d1to7: new Prisma.Decimal(0),
            d8to30: new Prisma.Decimal(0),
            d31to60: new Prisma.Decimal(0),
            d60plus: new Prisma.Decimal(0),
          },
          total: new Prisma.Decimal(0),
        };
        byCustomer.set(invoice.customerId, entry);
      }

      const bucket = bucketFor(daysPastDue(invoice.createdAt, invoice.customer.paymentTermDays, asOf, timeZone));
      entry.buckets[bucket] = entry.buckets[bucket].plus(outstanding);
      entry.total = entry.total.plus(outstanding);
    }

    return [...byCustomer.values()].sort(
      (a, b) => b.total.comparedTo(a.total) || a.customerName.localeCompare(b.customerName) || a.customerId.localeCompare(b.customerId),
    );
  }
}
