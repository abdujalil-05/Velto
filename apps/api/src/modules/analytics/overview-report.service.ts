import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { DateRangeQueryDto } from './dto/date-range.query';
import { companyTimeZone, resolveDateRange } from './report-utils';
import { invoiceDebt, orderTotalsInWindow } from './report-sql';

/** 9.2 "Hisobotlar ... umumiy" — company-wide summary for the window: turnover, active/new customers, and outstanding debt (17.2 KPI defs). */
@Injectable()
export class OverviewReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getOverview(query: DateRangeQueryDto) {
    const tx = this.tenantPrisma.client;
    const timeZone = await companyTimeZone(tx);
    const { start, end } = resolveDateRange(query.from, query.to, 30, timeZone);

    const [orders, newCustomers, totalCustomers, debt] = await Promise.all([
      orderTotalsInWindow(tx, start, end),
      tx.customer.count({ where: { createdAt: { gte: start, lte: end }, deletedAt: null } }),
      tx.customer.count({ where: { deletedAt: null } }),
      // Debt is a current snapshot, not scoped to the [start,end] window —
      // "qarzdorlik" is always "as of now" (see /reports/aging, same convention).
      invoiceDebt(tx, { kind: 'open', now: new Date() }),
    ]);
    const { turnover } = orders;
    const totalDebt = debt.total;
    const overdueDebt = debt.overdue;

    const orderCount = orders.deliveredOrderCount; // DELIVERED/CLOSED orders only (TURNOVER_STATUSES)
    return {
      range: { from: start, to: end },
      timeZone,
      turnover,
      orderCount,
      avgCheck: orderCount > 0 ? turnover.dividedBy(orderCount) : new Prisma.Decimal(0),
      activeCustomers: orders.activeCustomers,
      newCustomers,
      totalCustomers,
      totalDebt,
      overdueDebt,
      overdueDebtPct: totalDebt.greaterThan(0) ? Math.round(overdueDebt.dividedBy(totalDebt).times(1000).toNumber()) / 10 : 0,
    };
  }
}
