import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { DateRangeQueryDto } from './dto/date-range.query';
import { COUNTED_ORDER_STATUSES, companyTimeZone, eachCompanyDay, localDateString, resolveDateRange, ORDER_AMOUNT_SELECT, effectiveLineTotal, orderTotal } from './report-utils';

/** 9.2 "Hisobotlar ... sotuv" — turnover/order-count trend plus the agents and products driving it, for the given window (default: last 30 days). */
@Injectable()
export class SalesReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getSalesReport(query: DateRangeQueryDto) {
    const tx = this.tenantPrisma.client;
    const timeZone = await companyTimeZone(tx);
    const { start, end } = resolveDateRange(query.from, query.to, 30, timeZone);

    const orders = await tx.salesOrder.findMany({
      where: { createdAt: { gte: start, lte: end }, status: { in: COUNTED_ORDER_STATUSES } },
      select: {
        createdAt: true,
        agentId: true,
        agent: { select: { firstName: true, lastName: true } },
        status: true,
        lines: {
          select: { ...ORDER_AMOUNT_SELECT.lines.select, productId: true, product: { select: { name: true } } },
        },
      },
    });

    let turnover = new Prisma.Decimal(0);
    const byDay = new Map<string, Prisma.Decimal>();
    const byAgent = new Map<string, { name: string; turnover: Prisma.Decimal; orderCount: number }>();
    const byProduct = new Map<string, { name: string; turnover: Prisma.Decimal }>();

    for (const order of orders) {
      const amount = orderTotal(order);
      turnover = turnover.plus(amount);

      const dayKey = localDateString(order.createdAt, timeZone);
      byDay.set(dayKey, (byDay.get(dayKey) ?? new Prisma.Decimal(0)).plus(amount));

      if (order.agentId) {
        const name = order.agent ? `${order.agent.firstName} ${order.agent.lastName}` : '';
        const entry = byAgent.get(order.agentId) ?? { name, turnover: new Prisma.Decimal(0), orderCount: 0 };
        entry.turnover = entry.turnover.plus(amount);
        entry.orderCount += 1;
        byAgent.set(order.agentId, entry);
      }

      for (const line of order.lines) {
        const entry = byProduct.get(line.productId) ?? { name: line.product.name, turnover: new Prisma.Decimal(0) };
        entry.turnover = entry.turnover.plus(effectiveLineTotal(order.status, line));
        byProduct.set(line.productId, entry);
      }
    }

    const orderCount = orders.length;
    const byDayArray: { date: string; turnover: Prisma.Decimal }[] = [];
    for (const day of eachCompanyDay(start, end, timeZone)) {
      byDayArray.push({ date: day.date, turnover: byDay.get(day.date) ?? new Prisma.Decimal(0) });
    }

    return {
      range: { from: start, to: end },
      timeZone,
      summary: {
        turnover,
        orderCount,
        avgCheck: orderCount > 0 ? turnover.dividedBy(orderCount) : new Prisma.Decimal(0),
      },
      byDay: byDayArray,
      byAgent: [...byAgent.entries()]
        .map(([agentId, v]) => ({ agentId, agentName: v.name, turnover: v.turnover, orderCount: v.orderCount }))
        .sort((a, b) => b.turnover.comparedTo(a.turnover)),
      topProducts: [...byProduct.entries()]
        .map(([productId, v]) => ({ productId, productName: v.name, turnover: v.turnover }))
        .sort((a, b) => b.turnover.comparedTo(a.turnover))
        .slice(0, 10),
    };
  }
}
