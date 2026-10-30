import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentSource, PaymentStatus, Prisma, type TenantClient } from '@velto/database';
import { DEFAULT_DASHBOARD_CACHE_TTL_S } from '../../common/config/env.schema';
import { ReportConcurrencyLimiter } from '../../common/concurrency/report-concurrency.limiter';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { REPORT_TX_OPTIONS } from './report-tx.constants';
import { paymentPostedWithin } from '../finance/ledger-filters';
import { companyDay } from '../field/company-day';
import { AgingReportService, type AgingRow } from '../finance/reports/aging-report.service';
import { DAY_MS, companyTimeZone, eachCompanyDay, pctChange } from './report-utils';
import { invoiceDebtAsOfMany, turnoverPerAgent, turnoverPerDay } from './report-sql';

type DashboardResult = Awaited<ReturnType<DashboardService['computeQueries']>>;
type Completed = { data: DashboardResult; generatedAt: string; at: number };
/** Per key: the last COMPLETED value (served) and at most one refresh in flight (single-flight). */
type CacheEntry = { completed?: Completed; inflight?: Promise<Completed> };

const TOP_DEBTORS = 10;
/** Each dashboard query runs in its own short READ COMMITTED tenant tx so they use separate connections and overlap. */
const DASHBOARD_QUERY_TX = { ...REPORT_TX_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

function dashboardCacheTtlMs(): number {
  const raw = process.env.DASHBOARD_CACHE_TTL_S;
  const n = raw === undefined || raw === '' ? DEFAULT_DASHBOARD_CACHE_TTL_S : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) * 1000 : DEFAULT_DASHBOARD_CACHE_TTL_S * 1000;
}

/** DI token of the dashboard's own limiter (separate from the heavy-report semaphore). */
export const DASHBOARD_LIMITER = Symbol('DASHBOARD_LIMITER');

/** 9.3: the home dashboard — today's headline cards (each vs. yesterday), a 30-day turnover trend, today's per-agent activity, and the top debtors. */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly agingReport: AgingReportService,
    @Inject(DASHBOARD_LIMITER) private readonly limiter: ReportConcurrencyLimiter,
  ) {}

  /**
   * Dashboard JSON with a short per-company stale-while-revalidate cache
   * (screen only: exports and the aging/sales/overview services never go
   * through here and always recompute, ADR-027). Key = companyId + company
   * day + timezone.
   * - A completed value younger than TTL is a hit (`cached: true`), no DB, no permit.
   * - Age in [TTL, 2×TTL): EVERY caller (including the first) gets the stale
   *   value (`cached: true`) and ONE background refresh (single-flight) runs.
   *   The refresh is detached from the request's tenant context and uses the
   *   explicit companyId; its errors are logged and the stale value stays.
   * - Only a cold miss (no value, new company day, or value older than 2×TTL)
   *   waits for the compute and gets `cached: false`; a busy dashboard lane
   *   then yields 503 (ReportBusyException).
   * In-process Map bounded by active companies (entries without a refresh in
   * flight and older than 2×TTL are dropped): valid for a single API process
   * (PM2 instances=1, ADR-051). The dashboard permit (own limiter, not the
   * heavy-report one) is taken only by the compute. Called after the
   * permission check (TenantContextInterceptor), so a cached body is never
   * served to an unauthorised caller. The route is
   * @TenantTx({ scope: 'handler' }): no request tx is open here, so the
   * compute opens its own short tenant txs and waiters hold no connection.
   */
  async getDashboard(): Promise<DashboardResult & { generatedAt: string; cached: boolean }> {
    const ttlMs = dashboardCacheTtlMs();
    const companyId = this.tenantPrisma.companyId;
    if (ttlMs === 0) {
      const value = await this.compute(companyId, await this.readTimeZone(companyId), 'cold');
      return { ...value.data, generatedAt: value.generatedAt, cached: false };
    }
    // Hit fast path: last-seen timezone, no DB, no permit. A stale tz can only
    // serve an entry that is at most 2×TTL old.
    const knownTz = this.timeZones.get(companyId);
    if (knownTz) {
      const now = Date.now();
      const key = this.cacheKey(companyId, now, knownTz);
      const served = this.serveCompleted(this.cache.get(key), key, companyId, knownTz, now, ttlMs);
      if (served) return served;
    }
    const now = Date.now();
    const timeZone = await this.readTimeZone(companyId);
    const key = this.cacheKey(companyId, now, timeZone);
    let entry = this.cache.get(key);
    const served = this.serveCompleted(entry, key, companyId, timeZone, now, ttlMs);
    if (served) return served;
    if (!entry) {
      entry = {};
      this.cache.set(key, entry);
    }
    const value = await (entry.inflight ?? this.refresh(entry, key, companyId, timeZone, now, ttlMs));
    return { ...value.data, generatedAt: value.generatedAt, cached: false };
  }

  /** Serves a completed value younger than 2×TTL; past TTL it also starts the single background refresh. */
  private serveCompleted(entry: CacheEntry | undefined, key: string, companyId: string, timeZone: string, now: number, ttlMs: number) {
    const done = entry?.completed;
    if (!entry || !done) return null;
    const age = now - done.at;
    if (age >= 2 * ttlMs) return null;
    if (age >= ttlMs && !entry.inflight) {
      TenantContext.detached(() => this.refresh(entry, key, companyId, timeZone, now, ttlMs)).catch((err: unknown) => {
        this.logger.warn(`dashboard background refresh failed: ${err instanceof Error ? err.name : 'error'}`);
      });
    }
    return { ...done.data, generatedAt: done.generatedAt, cached: true };
  }

  /** Starts the single refresh for `entry`; only success replaces the completed value. */
  private refresh(entry: CacheEntry, key: string, companyId: string, timeZone: string, now: number, ttlMs: number): Promise<Completed> {
    const inflight = this.compute(companyId, timeZone, entry.completed ? 'refresh' : 'cold').then(
      (value) => {
        entry.completed = value;
        entry.inflight = undefined;
        return value;
      },
      (err: unknown) => {
        entry.inflight = undefined;
        if (!entry.completed) this.cache.delete(key);
        throw err;
      },
    );
    entry.inflight = inflight;
    // Drop idle entries opportunistically so the Map stays bounded by active companies.
    for (const [k, e] of this.cache) {
      if (!e.inflight && (!e.completed || now - e.completed.at >= 2 * ttlMs)) this.cache.delete(k);
    }
    return inflight;
  }

  private async readTimeZone(companyId: string): Promise<string> {
    const timeZone = await this.tenantPrisma.run(companyId, (tx) => companyTimeZone(tx));
    this.timeZones.set(companyId, timeZone);
    return timeZone;
  }

  private cacheKey(companyId: string, now: number, timeZone: string): string {
    return `${companyId}|${companyDay(new Date(now), timeZone).date}|${timeZone}`;
  }

  /** Test hook. */
  clearCache() {
    this.cache.clear();
    this.timeZones.clear();
  }

  private readonly cache = new Map<string, CacheEntry>();
  private readonly timeZones = new Map<string, string>();

  /**
   * Only the single compute takes a dashboard permit (per-tenant quota applies
   * here); hits and waiters never reach this. The query txs open after the
   * permit is held, so a queued compute holds no pool connection. Logs one
   * structured line per compute.
   */
  private async compute(companyId: string, timeZone: string, mode: 'cold' | 'refresh'): Promise<Completed> {
    const t0 = Date.now();
    const release = await this.limiter.acquire(undefined, companyId);
    const permitWaitMs = Date.now() - t0;
    const t1 = Date.now();
    let poolWaitMs = 0;
    try {
      const data = await this.computeQueries(companyId, timeZone, (ms) => {
        poolWaitMs = Math.max(poolWaitMs, ms);
      });
      const at = Date.now();
      this.logger.log({ event: 'dashboard.compute', mode, companyId, permitWaitMs, poolWaitMs, computeMs: at - t1 });
      return { data, generatedAt: new Date(at).toISOString(), at };
    } finally {
      release();
    }
  }

  /**
   * The independent queries run concurrently, each in its own short tenant tx
   * (one pool connection each, 6 per compute at peak), so wall time ≈ the
   * slowest query instead of their sum. Every query still runs under RLS via
   * TenantPrismaService.run. Settled (not Promise.all) so the permit is held
   * until every tx has finished, even when one fails.
   */
  private async computeQueries(companyId: string, timeZone: string, onPoolWait: (ms: number) => void) {
    const now = new Date();
    const today = companyDay(now, timeZone);
    const yesterday = companyDay(new Date(today.start.getTime() - 1), timeZone);
    const todayStart = today.start;
    const todayEnd = new Date(today.end.getTime() - 1);
    const yesterdayStart = yesterday.start;
    const yesterdayEnd = new Date(yesterday.end.getTime() - 1);
    const trendStart = companyDay(new Date(todayStart.getTime() - 29 * DAY_MS + 12 * 3_600_000), timeZone).start;
    const inTx = <T>(fn: (tx: TenantClient) => Promise<T>) => {
      const requestedAt = Date.now();
      return this.tenantPrisma.run(
        companyId,
        (tx) => {
          onPoolWait(Date.now() - requestedAt);
          return fn(tx);
        },
        DASHBOARD_QUERY_TX,
      );
    };

    const settled = await Promise.allSettled([
      inTx((tx) => this.paymentsTotal(tx, todayStart, todayEnd)),
      inTx((tx) => this.paymentsTotal(tx, yesterdayStart, yesterdayEnd)),
      // One scan for both snapshots (now / end of yesterday). Yesterday is a best-effort reconstruction: invoices cancelled since are excluded.
      inTx((tx) => invoiceDebtAsOfMany(tx, [now, yesterdayEnd])),
      inTx((tx) => turnoverPerDay(tx, trendStart, todayEnd, timeZone)),
      inTx((tx) => this.agentsToday(tx, todayStart, todayEnd, today.isoWeekday)),
      inTx(() => this.agingReport.topDebtors(today.date, timeZone, TOP_DEBTORS)),
    ] as const);
    for (const r of settled) if (r.status === 'rejected') throw r.reason;
    const [todayCollected, yesterdayCollected, overdueDebt, dailyOrders, agentsToday, topDebtors] = settled.map(
      (r) => (r as PromiseFulfilledResult<unknown>).value,
    ) as unknown as [
      Prisma.Decimal,
      Prisma.Decimal,
      Awaited<ReturnType<typeof invoiceDebtAsOfMany>>,
      Awaited<ReturnType<typeof turnoverPerDay>>,
      Awaited<ReturnType<DashboardService['agentsToday']>>,
      AgingRow[],
    ];

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
      topDebtors,
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
