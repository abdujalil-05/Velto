import { Injectable } from '@nestjs/common';
import { Prisma, VisitOutcome } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { DateRangeQueryDto } from './dto/date-range.query';
import { COUNTED_ORDER_STATUSES, DAY_MS, isoWeekday, resolveDateRange, sumLineTotals } from './report-utils';

/** 9.2 "agent samaradorligi (asosiy)" / 17.2 KPI: route completion and effective-visit ratio, plus order count/turnover/avg-check, per agent over the window. */
@Injectable()
export class AgentPerformanceReportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getAgentPerformance(query: DateRangeQueryDto) {
    const { start, end } = resolveDateRange(query.from, query.to);
    const tx = this.tenantPrisma.client;

    const agents = await tx.user.findMany({
      where: { isActive: true, roles: { some: { role: { code: 'SALES_AGENT' } } } },
      select: { id: true, firstName: true, lastName: true },
    });
    if (agents.length === 0) return { range: { from: start, to: end }, agents: [] };
    const agentIds = agents.map((a) => a.id);

    const [routes, visits, orders] = await Promise.all([
      tx.route.findMany({
        where: { agentId: { in: agentIds } },
        select: { agentId: true, weekday: true, _count: { select: { stops: true } } },
      }),
      tx.visit.findMany({
        where: { agentId: { in: agentIds }, startedAt: { gte: start, lte: end } },
        select: { agentId: true, outcome: true },
      }),
      tx.salesOrder.findMany({
        where: { agentId: { in: agentIds }, createdAt: { gte: start, lte: end }, status: { in: COUNTED_ORDER_STATUSES } },
        select: { agentId: true, lines: { select: { lineTotal: true } } },
      }),
    ]);

    // Planned visits over the whole window: every day contributes the stop
    // count of every route whose weekday matches that day (17.2 "Marshrut
    // bajarilishi" needs a denominator across the range, not just one day).
    const plannedByAgent = new Map<string, number>();
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      const weekday = isoWeekday(new Date(t));
      for (const route of routes) {
        if (route.weekday !== weekday) continue;
        // A supplier-served route (agentId null) never matches the
        // `agentId: { in: agentIds } ` filter above, but its static type is
        // still nullable — guard rather than assert.
        if (!route.agentId) continue;
        plannedByAgent.set(route.agentId, (plannedByAgent.get(route.agentId) ?? 0) + route._count.stops);
      }
    }

    const completedByAgent = new Map<string, number>();
    const orderedByAgent = new Map<string, number>();
    for (const visit of visits) {
      completedByAgent.set(visit.agentId, (completedByAgent.get(visit.agentId) ?? 0) + 1);
      if (visit.outcome === VisitOutcome.ORDERED) {
        orderedByAgent.set(visit.agentId, (orderedByAgent.get(visit.agentId) ?? 0) + 1);
      }
    }

    const orderStatsByAgent = new Map<string, { count: number; turnover: Prisma.Decimal }>();
    for (const order of orders) {
      if (!order.agentId) continue;
      const entry = orderStatsByAgent.get(order.agentId) ?? { count: 0, turnover: new Prisma.Decimal(0) };
      entry.count += 1;
      entry.turnover = entry.turnover.plus(sumLineTotals(order.lines));
      orderStatsByAgent.set(order.agentId, entry);
    }

    const rows = agents.map((agent) => {
      const planned = plannedByAgent.get(agent.id) ?? 0;
      const completed = completedByAgent.get(agent.id) ?? 0;
      const ordered = orderedByAgent.get(agent.id) ?? 0;
      const stats = orderStatsByAgent.get(agent.id) ?? { count: 0, turnover: new Prisma.Decimal(0) };

      return {
        agentId: agent.id,
        agentName: `${agent.firstName} ${agent.lastName}`,
        plannedVisits: planned,
        completedVisits: completed,
        routeCompletionPct: planned > 0 ? Math.round((completed / planned) * 1000) / 10 : null,
        effectiveVisitPct: completed > 0 ? Math.round((ordered / completed) * 1000) / 10 : null,
        orderCount: stats.count,
        turnover: stats.turnover,
        avgCheck: stats.count > 0 ? stats.turnover.dividedBy(stats.count) : new Prisma.Decimal(0),
      };
    });

    rows.sort((a, b) => b.turnover.comparedTo(a.turnover));
    return { range: { from: start, to: end }, agents: rows };
  }
}
