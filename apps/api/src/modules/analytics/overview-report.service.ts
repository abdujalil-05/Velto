import { Injectable } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { DateRangeQueryDto } from './dto/date-range.query';
import { COUNTED_ORDER_STATUSES, DAY_MS, resolveDateRange, sumLineTotals } from './report-utils';

/** 9.2 "Hisobotlar ... umumiy" — company-wide summary for the window: turnover, active/new customers, and outstanding debt (17.2 KPI defs). */
@Injectable()
export class OverviewReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getOverview(query: DateRangeQueryDto) {
    const { start, end } = resolveDateRange(query.from, query.to);
    const tx = this.tenantPrisma.client;

    const [orders, newCustomers, totalCustomers, openInvoices] = await Promise.all([
      tx.salesOrder.findMany({
        where: { createdAt: { gte: start, lte: end }, status: { in: COUNTED_ORDER_STATUSES } },
        select: { customerId: true, lines: { select: { lineTotal: true } } },
      }),
      tx.customer.count({ where: { createdAt: { gte: start, lte: end }, deletedAt: null } }),
      tx.customer.count({ where: { deletedAt: null } }),
      tx.invoice.findMany({
        where: { status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIALLY_PAID] } },
        include: { allocations: true, customer: { select: { paymentTermDays: true } } },
      }),
    ]);

    let turnover = new Prisma.Decimal(0);
    const activeCustomers = new Set<string>();
    for (const order of orders) {
      turnover = turnover.plus(sumLineTotals(order.lines));
      activeCustomers.add(order.customerId);
    }

    // Debt is a current snapshot, not scoped to the [start,end] window —
    // "qarzdorlik" is always "as of now" (see /reports/aging, same convention).
    let totalDebt = new Prisma.Decimal(0);
    let overdueDebt = new Prisma.Decimal(0);
    const now = Date.now();
    for (const invoice of openInvoices) {
      const allocated = invoice.allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
      const outstanding = invoice.total.minus(allocated);
      if (!outstanding.greaterThan(0)) continue;
      totalDebt = totalDebt.plus(outstanding);

      const dueAt = invoice.createdAt.getTime() + invoice.customer.paymentTermDays * DAY_MS;
      if (dueAt < now) overdueDebt = overdueDebt.plus(outstanding);
    }

    const orderCount = orders.length;
    return {
      range: { from: start, to: end },
      turnover,
      orderCount,
      avgCheck: orderCount > 0 ? turnover.dividedBy(orderCount) : new Prisma.Decimal(0),
      activeCustomers: activeCustomers.size,
      newCustomers,
      totalCustomers,
      totalDebt,
      overdueDebt,
      overdueDebtPct: totalDebt.greaterThan(0) ? Math.round(overdueDebt.dividedBy(totalDebt).times(1000).toNumber()) / 10 : 0,
    };
  }
}
