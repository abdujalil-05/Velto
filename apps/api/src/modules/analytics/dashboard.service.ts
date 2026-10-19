import { Injectable } from '@nestjs/common';
import { PaymentSource, PaymentStatus, Prisma, type TenantClient } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { paymentPostedWithin } from '../finance/ledger-filters';
import { companyDay } from '../field/company-day';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { DAY_MS, companyTimeZone, eachCompanyDay, pctChange } from './report-utils';
import { invoiceDebt, turnoverPerAgent, turnoverPerDay } from './report-sql';


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
      todayCollected,
      yesterdayCollected,
      overdueNow,
      overdueYesterday,
      dailyOrders,
      agentsToday,
      topDebtors,
    ] = await Promise.all([
      this.paymentsTotal(tx, todayStart, todayEnd),
      this.paymentsTotal(tx, yesterdayStart, yesterdayEnd),
      this.overdueDebtAsOf(tx, now),
      this.overdueDebtAsOf(tx, yesterdayEnd),
      turnoverPerDay(tx, trendStart, todayEnd, timeZone),
      this.agentsToday(tx, todayStart, todayEnd, today.isoWeekday),
      this.agingReport.getAging({ page: 1, pageSize: 10 }),
    ]);

    // Today/yesterday cards come from the same per-day aggregation as the trend (one scan, same company-day boundaries).
    const zero = { turnover: new Prisma.Decimal(0), count: 0 };
    const todayOrders = dailyOrders.get(today.date) ?? zero;
    const yesterdayOrders = dailyOrders.get(yesterday.date) ?? zero;
    const turnoverLast30Days = eachCompanyDay(trendStart, todayEnd, timeZone).map((day) => ({
      date: day.date,
      turnover: dailyOrders.get(day.date)?.turnover ?? zero.turnover,
    }));

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

  /** Money collected in the window — F6 OPENING credit is a carried-over balance, not a collection. */
  private async paymentsTotal(tx: TenantClient, start: Date, end: Date) {
    const agg = await tx.payment.aggregate({
      where: { ...paymentPostedWithin({ gte: start, lte: end }), status: PaymentStatus.POSTED, source: PaymentSource.COLLECTION },
      _sum: { amount: true },
    });
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
    return (await invoiceDebt(tx, { kind: 'asOf', asOf })).overdue;
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
      turnoverPerAgent(tx, start, end, agentIds),
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

    const orderStatsByAgent = new Map(ordersToday.map((o) => [o.agentId, { count: o.count, turnover: o.turnover }]));

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
