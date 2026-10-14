import { Injectable } from '@nestjs/common';
import { InvoiceStatus, PaymentStatus, Prisma, type TenantClient } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { VALID_ALLOCATION_WHERE } from '../finance/ledger-filters';
import { companyDay } from '../field/company-day';
import { AgingReportService } from '../finance/reports/aging-report.service';
import {
  COUNTED_ORDER_STATUSES,
  DAY_MS,
  companyTimeZone,
  eachCompanyDay,
  localDateString,
  pctChange,
  ORDER_AMOUNT_SELECT,
  orderTotal,
} from './report-utils';


/** 9.3: the home dashboard — today's headline cards (each vs. yesterday), a 30-day turnover trend, today's per-agent activity, and the top debtors. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly agingReport: AgingReportService,
  ) {}

  async getDashboard() {
    const tx = this.tenantPrisma.client;
    const now = new Date();
    const timeZone = await companyTimeZone(tx);
    const today = companyDay(now, timeZone);
    const yesterday = companyDay(new Date(today.start.getTime() - 1), timeZone);
    const todayStart = today.start;
    const todayEnd = new Date(today.end.getTime() - 1);
    const yesterdayStart = yesterday.start;
    const yesterdayEnd = new Date(yesterday.end.getTime() - 1);
    const trendStart = companyDay(new Date(todayStart.getTime() - 29 * DAY_MS + 12 * 3_600_000), timeZone).start;

    const [
      todayOrders,
      yesterdayOrders,
      todayCollected,
      yesterdayCollected,
      overdueNow,
      overdueYesterday,
      turnoverLast30Days,
      agentsToday,
      topDebtors,
    ] = await Promise.all([
      this.ordersTotals(tx, todayStart, todayEnd),
      this.ordersTotals(tx, yesterdayStart, yesterdayEnd),
      this.paymentsTotal(tx, todayStart, todayEnd),
      this.paymentsTotal(tx, yesterdayStart, yesterdayEnd),
      this.overdueDebtAsOf(tx, now),
      this.overdueDebtAsOf(tx, yesterdayEnd),
      this.turnoverByDay(tx, trendStart, todayEnd, timeZone),
      this.agentsToday(tx, todayStart, todayEnd, today.isoWeekday),
      this.agingReport.getAging({ page: 1, pageSize: 10 }),
    ]);

    return {
      today: {
        turnover: todayOrders.turnover,
        turnoverChangePct: pctChange(todayOrders.turnover, yesterdayOrders.turnover),
        orderCount: todayOrders.count,
        orderCountChangePct: pctChange(todayOrders.count, yesterdayOrders.count),
        collected: todayCollected,
        collectedChangePct: pctChange(todayCollected, yesterdayCollected),
        overdueDebt: overdueNow,
        overdueDebtChangePct: pctChange(overdueNow, overdueYesterday),
      },
      turnoverLast30Days,
      agentsToday,
      topDebtors: topDebtors.data,
    };
  }

  private async ordersTotals(tx: TenantClient, start: Date, end: Date) {
    const orders = await tx.salesOrder.findMany({
      where: { createdAt: { gte: start, lte: end }, status: { in: COUNTED_ORDER_STATUSES } },
      select: ORDER_AMOUNT_SELECT,
    });
    return { turnover: orders.reduce((sum, o) => sum.plus(orderTotal(o)), new Prisma.Decimal(0)), count: orders.length };
  }

  private async paymentsTotal(tx: TenantClient, start: Date, end: Date) {
    const agg = await tx.payment.aggregate({ where: { createdAt: { gte: start, lte: end }, status: PaymentStatus.POSTED }, _sum: { amount: true } });
    return agg._sum.amount ?? new Prisma.Decimal(0);
  }

  /**
   * Best-effort historical reconstruction for the "vs yesterday" delta on a
   * snapshot metric that has no real "yesterday" value without full event
   * sourcing: invoices that existed by `asOf`, minus whatever had been
   * allocated to them by `asOf`, counted only if already overdue at that
   * point. Invoices cancelled since `asOf` are still excluded from the
   * result even though they may have still been active then — cancellations
   * are rare and happen close to same-day in practice, so this is the one
   * place the approximation can diverge from a true point-in-time value.
   */
  private async overdueDebtAsOf(tx: TenantClient, asOf: Date): Promise<Prisma.Decimal> {
    const invoices = await tx.invoice.findMany({
      where: { createdAt: { lte: asOf }, status: { not: InvoiceStatus.CANCELLED } },
      include: {
        allocations: { where: VALID_ALLOCATION_WHERE, include: { payment: { select: { createdAt: true } } } },
        customer: { select: { paymentTermDays: true } },
      },
    });

    let total = new Prisma.Decimal(0);
    for (const invoice of invoices) {
      const allocatedByAsOf = invoice.allocations
        .filter((a) => a.payment.createdAt <= asOf)
        .reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
      const outstanding = invoice.total.minus(allocatedByAsOf);
      if (!outstanding.greaterThan(0)) continue;

      const dueAt = invoice.createdAt.getTime() + invoice.customer.paymentTermDays * DAY_MS;
      if (dueAt < asOf.getTime()) total = total.plus(outstanding);
    }
    return total;
  }

  private async turnoverByDay(tx: TenantClient, start: Date, end: Date, timeZone: string) {
    const orders = await tx.salesOrder.findMany({
      where: { createdAt: { gte: start, lte: end }, status: { in: COUNTED_ORDER_STATUSES } },
      select: { createdAt: true, ...ORDER_AMOUNT_SELECT },
    });

    const byDay = new Map<string, Prisma.Decimal>();
    for (const order of orders) {
      const key = localDateString(order.createdAt, timeZone);
      byDay.set(key, (byDay.get(key) ?? new Prisma.Decimal(0)).plus(orderTotal(order)));
    }

    const days: { date: string; turnover: Prisma.Decimal }[] = [];
    for (const day of eachCompanyDay(start, end, timeZone)) {
      days.push({ date: day.date, turnover: byDay.get(day.date) ?? new Prisma.Decimal(0) });
    }
    return days;
  }

  private async agentsToday(tx: TenantClient, start: Date, end: Date, weekday: number) {
    const agents = await tx.user.findMany({
      where: { isActive: true, roles: { some: { role: { code: 'SALES_AGENT' } } } },
      select: { id: true, firstName: true, lastName: true },
    });
    if (agents.length === 0) return [];
    const agentIds = agents.map((a) => a.id);

    const [routesToday, visitsToday, ordersToday] = await Promise.all([
      tx.route.findMany({
        where: { weekday, agentId: { in: agentIds } },
        select: { agentId: true, _count: { select: { stops: true } } },
      }),
      tx.visit.findMany({ where: { agentId: { in: agentIds }, startedAt: { gte: start, lte: end } }, select: { agentId: true } }),
      tx.salesOrder.findMany({
        where: { agentId: { in: agentIds }, createdAt: { gte: start, lte: end }, status: { in: COUNTED_ORDER_STATUSES } },
        select: { agentId: true, ...ORDER_AMOUNT_SELECT },
      }),
    ]);

    const plannedByAgent = new Map<string, number>();
    for (const route of routesToday) {
      // A courier-served route (agentId null) never matches the
      // `agentId: { in: agentIds } ` filter above, but its static type is
      // still nullable — guard rather than assert.
      if (!route.agentId) continue;
      plannedByAgent.set(route.agentId, (plannedByAgent.get(route.agentId) ?? 0) + route._count.stops);
    }

    const completedByAgent = new Map<string, number>();
    for (const visit of visitsToday) {
      completedByAgent.set(visit.agentId, (completedByAgent.get(visit.agentId) ?? 0) + 1);
    }

    const orderStatsByAgent = new Map<string, { count: number; turnover: Prisma.Decimal }>();
    for (const order of ordersToday) {
      if (!order.agentId) continue;
      const entry = orderStatsByAgent.get(order.agentId) ?? { count: 0, turnover: new Prisma.Decimal(0) };
      entry.count += 1;
      entry.turnover = entry.turnover.plus(orderTotal(order));
      orderStatsByAgent.set(order.agentId, entry);
    }

    return agents.map((agent) => {
      const stats = orderStatsByAgent.get(agent.id) ?? { count: 0, turnover: new Prisma.Decimal(0) };
      return {
        agentId: agent.id,
        agentName: `${agent.firstName} ${agent.lastName}`,
        plannedVisits: plannedByAgent.get(agent.id) ?? 0,
        completedVisits: completedByAgent.get(agent.id) ?? 0,
        orderCount: stats.count,
        turnover: stats.turnover,
      };
    });
  }
}
