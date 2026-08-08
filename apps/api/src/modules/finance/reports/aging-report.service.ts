import { Injectable } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@velto/database';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import type { AgingReportQueryDto } from '../dto/aging-report.query';

export interface AgingBuckets {
  current: Prisma.Decimal;
  d1to30: Prisma.Decimal;
  d31to60: Prisma.Decimal;
  d61to90: Prisma.Decimal;
  d90plus: Prisma.Decimal;
}

export interface AgingRow {
  customerId: string;
  customerName: string;
  buckets: AgingBuckets;
  total: Prisma.Decimal;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AgingReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * 3.1 / 9.2 "/receivables": debt aged into 5 buckets by days past due
   * (due date = Invoice.createdAt + Customer.paymentTermDays), one row per
   * customer with an outstanding balance, sorted by total descending so the
   * biggest debtors surface first (reused as-is for the dashboard's "top 10
   * qarzdor" list, once that screen exists, via pageSize=10).
   */
  async getAging(query: AgingReportQueryDto) {
    const rows = await this.computeRows();
    const start = (query.page - 1) * query.pageSize;
    const data = rows.slice(start, start + query.pageSize);
    return paginate(data, rows.length, query.page, query.pageSize);
  }

  /** 9.1 "Excel eksport" needs every indebted customer, not just one page — 7.1's pageSize=100 cap is for UI list responses, not file exports. */
  async getAllRows(): Promise<AgingRow[]> {
    return this.computeRows();
  }

  private async computeRows(): Promise<AgingRow[]> {
    const tx = this.tenantPrisma.client;
    const now = Date.now();

    const invoices = await tx.invoice.findMany({
      where: { status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIALLY_PAID] } },
      include: {
        allocations: true,
        customer: { select: { id: true, name: true, paymentTermDays: true } },
      },
    });

    const byCustomer = new Map<string, AgingRow>();

    for (const invoice of invoices) {
      const allocated = invoice.allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
      const outstanding = invoice.total.minus(allocated);
      // Decimal.isPositive() is sign-based and true for zero too (see the
      // same note in PaymentsService) — an explicit > 0 comparison is needed
      // to actually exclude fully-settled invoices from the report.
      if (!outstanding.greaterThan(0)) continue;

      const dueAt = invoice.createdAt.getTime() + invoice.customer.paymentTermDays * DAY_MS;
      const daysOverdue = Math.floor((now - dueAt) / DAY_MS);

      let entry = byCustomer.get(invoice.customerId);
      if (!entry) {
        entry = {
          customerId: invoice.customerId,
          customerName: invoice.customer.name,
          buckets: {
            current: new Prisma.Decimal(0),
            d1to30: new Prisma.Decimal(0),
            d31to60: new Prisma.Decimal(0),
            d61to90: new Prisma.Decimal(0),
            d90plus: new Prisma.Decimal(0),
          },
          total: new Prisma.Decimal(0),
        };
        byCustomer.set(invoice.customerId, entry);
      }

      if (daysOverdue <= 0) entry.buckets.current = entry.buckets.current.plus(outstanding);
      else if (daysOverdue <= 30) entry.buckets.d1to30 = entry.buckets.d1to30.plus(outstanding);
      else if (daysOverdue <= 60) entry.buckets.d31to60 = entry.buckets.d31to60.plus(outstanding);
      else if (daysOverdue <= 90) entry.buckets.d61to90 = entry.buckets.d61to90.plus(outstanding);
      else entry.buckets.d90plus = entry.buckets.d90plus.plus(outstanding);

      entry.total = entry.total.plus(outstanding);
    }

    return [...byCustomer.values()].sort((a, b) => b.total.comparedTo(a.total));
  }
}
