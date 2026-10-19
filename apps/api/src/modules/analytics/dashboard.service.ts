import { Injectable } from '@nestjs/common';
import { PaymentSource, PaymentStatus, Prisma, type TenantClient } from '@velto/database';
import { DEFAULT_DASHBOARD_CACHE_TTL_S } from '../../common/config/env.schema';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { paymentPostedWithin } from '../finance/ledger-filters';
import { companyDay } from '../field/company-day';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { DAY_MS, companyTimeZone, eachCompanyDay, pctChange } from './report-utils';
import { invoiceDebtAsOfMany, turnoverPerAgent, turnoverPerDay } from './report-sql';

type DashboardResult = Awaited<ReturnType<DashboardService['compute']>>;
type CacheEntry = { expiresAt: number; value: Promise<{ data: DashboardResult; generatedAt: string }> };

function dashboardCacheTtlMs(): number {
  const raw = process.env.DASHBOARD_CACHE_TTL_S;
  const n = raw === undefined || raw === '' ? DEFAULT_DASHBOARD_CACHE_TTL_S : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) * 1000 : DEFAULT_DASHBOARD_CACHE_TTL_S * 1000;
}

/** 9.3: the home dashboard — today's headline cards (each vs. yesterday), a 30-day turnover trend, today's per-agent activity, and the top debtors. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly agingReport: AgingReportService,
  ) {}

  /**
   * Dashboard JSON with a short per-company cache (screen only: exports and
   * the aging/sales/overview services never go through here and always
   * recompute, ADR-027). Key = companyId + company day + timezone. Concurrent
   * misses share one in-flight computation (no stampede); failures are not
   * cached. In-process Map: valid for a single API process (PM2 instances=1,
   * ADR-051) — several processes would each hold their own copy (needs Redis).
   * Called after the permission check (TenantContextInterceptor), so a cached
   * body is never served to an unauthorised caller.
   */
  async getDashboard(): Promise<DashboardResult & { generatedAt: string; cached: boolean }> {
    const ttlMs = dashboardCacheTtlMs();
    if (ttlMs === 0) return { ...(await this.compute()), generatedAt: new Date().toISOString(), cached: false };
    const tx = this.tenantPrisma.client;
    const now = Date.now();
    const timeZone = await companyTimeZone(tx);
    const key = `${this.tenantPrisma.companyId}|${companyDay(new Date(now), timeZone).date}|${timeZone}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      const value = await hit.value;
      return { ...value.data, generatedAt: value.generatedAt, cached: true };
    }
    const entry: CacheEntry = {
      expiresAt: now + ttlMs,
      value: this.compute().then((data) => ({ data, generatedAt: new Date().toISOString() })),
    };
    this.cache.set(key, entry);
    // Drop expired entries opportunistically so the Map stays bounded by active companies.
    for (const [k, e] of this.cache) if (e.expiresAt <= now) this.cache.delete(k);
    try {
      const value = await entry.value;
      return { ...value.data, generatedAt: value.generatedAt, cached: false };
    } catch (err) {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw err;
    }
  }

  /**
   * Guard probe (no DB): true when this company has a live cache entry (done or
   * in flight), so the request does no new report computation and needs no
   * semaphore permit. The response is still served only after the permission
   * check in TenantContextInterceptor.
   */
  hasLiveEntry(companyId: string): boolean {
    const now = Date.now();
    const prefix = `${companyId}|`;
    for (const [k, e] of this.cache) if (e.expiresAt > now && k.startsWith(prefix)) return true;
    return false;
  }

  /** Test hook. */
  clearCache() {
    this.cache.clear();
  }

  private readonly cache = new Map<string, CacheEntry>();

  private async compute() {
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
      overdueDebt,
      dailyOrders,
      agentsToday,
      topDebtors,
    ] = await Promise.all([
      this.paymentsTotal(tx, todayStart, todayEnd),
      this.paymentsTotal(tx, yesterdayStart, yesterdayEnd),
      // One scan for both snapshots (now / end of yesterday). Yesterday is a best-effort reconstruction: invoices cancelled since are excluded.
      invoiceDebtAsOfMany(tx, [now, yesterdayEnd]),
      turnoverPerDay(tx, trendStart, todayEnd, timeZone),
      this.agentsToday(tx, todayStart, todayEnd, today.isoWeekday),
      this.agingReport.getAging({ page: 1, pageSize: 10 }),
    ]);

    const overdueNow = overdueDebt[0]!.overdue;
    const overdueYesterday = overdueDebt[1]!.overdue;

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
