import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { DateRangeQueryDto } from './dto/date-range.query';
import { companyTimeZone, eachCompanyDay, resolveDateRange } from './report-utils';
import { orderTotalsInWindow, topProductsInWindow, turnoverPerAgent, turnoverPerDay } from './report-sql';

/** 9.2 "Hisobotlar ... sotuv" — turnover/order-count trend plus the agents and products driving it, for the given window (default: last 30 days). */
@Injectable()
export class SalesReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getSalesReport(query: DateRangeQueryDto) {
    const tx = this.tenantPrisma.client;
    const timeZone = await companyTimeZone(tx);
    const { start, end } = resolveDateRange(query.from, query.to, 30, timeZone);

    const [totals, byDay, agentRows, topProducts] = await Promise.all([
      orderTotalsInWindow(tx, start, end),
      turnoverPerDay(tx, start, end, timeZone),
      turnoverPerAgent(tx, start, end),
      topProductsInWindow(tx, start, end, 10),
    ]);
    const agents = agentRows.length
      ? await tx.user.findMany({ where: { id: { in: agentRows.map((a) => a.agentId) } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const agentNames = new Map(agents.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));

    // orderCount = number of DELIVERED/CLOSED orders (TURNOVER_STATUSES), not submitted ones.
    const { turnover, deliveredOrderCount: orderCount } = totals;
    const byDayArray = eachCompanyDay(start, end, timeZone).map((day) => ({
      date: day.date,
      turnover: byDay.get(day.date)?.turnover ?? new Prisma.Decimal(0),
    }));

    return {
      range: { from: start, to: end },
      timeZone,
      summary: {
        turnover,
        orderCount,
        avgCheck: orderCount > 0 ? turnover.dividedBy(orderCount) : new Prisma.Decimal(0),
      },
      byDay: byDayArray,
      byAgent: agentRows
        .map((v) => ({ agentId: v.agentId, agentName: agentNames.get(v.agentId) ?? '', turnover: v.turnover, orderCount: v.deliveredOrderCount }))
        .sort((a, b) => b.turnover.comparedTo(a.turnover)),
      topProducts,
    };
  }
}
