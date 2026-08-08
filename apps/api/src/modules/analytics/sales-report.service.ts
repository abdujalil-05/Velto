import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { DateRangeQueryDto } from './dto/date-range.query';
import { COUNTED_ORDER_STATUSES, DAY_MS, localDateString, resolveDateRange, sumLineTotals } from './report-utils';

/** 9.2 "Hisobotlar ... sotuv" — turnover/order-count trend plus the agents and products driving it, for the given window (default: last 30 days). */
@Injectable()
export class SalesReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getSalesReport(query: DateRangeQueryDto) {
    const { start, end } = resolveDateRange(query.from, query.to);
    const tx = this.tenantPrisma.client;

    const orders = await tx.salesOrder.findMany({
      where: { createdAt: { gte: start, lte: end }, status: { in: COUNTED_ORDER_STATUSES } },
      select: {
        createdAt: true,
        agentId: true,
        agent: { select: { firstName: true, lastName: true } },
        lines: { select: { lineTotal: true, productId: true, product: { select: { name: true } } } },
      },
    });

    let turnover = new Prisma.Decimal(0);
    const byDay = new Map<string, Prisma.Decimal>();
    const byAgent = new Map<string, { name: string; turnover: Prisma.Decimal; orderCount: number }>();
    const byProduct = new Map<string, { name: string; turnover: Prisma.Decimal }>();

    for (const order of orders) {
      const orderTotal = sumLineTotals(order.lines);
      turnover = turnover.plus(orderTotal);

      const dayKey = localDateString(order.createdAt);
      byDay.set(dayKey, (byDay.get(dayKey) ?? new Prisma.Decimal(0)).plus(orderTotal));

      if (order.agentId) {
        const name = order.agent ? `${order.agent.firstName} ${order.agent.lastName}` : '';
        const entry = byAgent.get(order.agentId) ?? { name, turnover: new Prisma.Decimal(0), orderCount: 0 };
        entry.turnover = entry.turnover.plus(orderTotal);
        entry.orderCount += 1;
        byAgent.set(order.agentId, entry);
      }

      for (const line of order.lines) {
        const entry = byProduct.get(line.productId) ?? { name: line.product.name, turnover: new Prisma.Decimal(0) };
        entry.turnover = entry.turnover.plus(line.lineTotal);
        byProduct.set(line.productId, entry);
      }
    }

    const orderCount = orders.length;
    const byDayArray: { date: string; turnover: Prisma.Decimal }[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      const key = localDateString(new Date(t));
      byDayArray.push({ date: key, turnover: byDay.get(key) ?? new Prisma.Decimal(0) });
    }

    return {
      range: { from: start, to: end },
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
