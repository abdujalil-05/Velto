import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvoiceKind, InvoiceStatus, OrderStatus, PaymentMethod, PaymentSource, PaymentStatus, prisma, systemPrisma } from '@velto/database';
import { ReportConcurrencyLimiter } from '../../common/concurrency/report-concurrency.limiter';
import { TenantContext, handlerScopeStore } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { DashboardService } from './dashboard.service';

/**
 * F7.6 golden-equality safety net. The EXPECTED values below were captured from the
 * PRE-refactor code (DashboardService.computeInTx + AgingReportService.computeRows, branch
 * feat/f7-6-dashboard-perf) on this fixed fixture. Business numbers must not change in the
 * refactor (parallel short tx / SWR cache / SQL top-10): if this fails, the refactor changed numbers.
 *
 * Fixed "now" = 2026-06-15T10:00:00Z = Monday 15:00 in Asia/Tashkent (UTC+5). Only Date is faked.
 * Company day today = [2026-06-14T19:00Z, 2026-06-15T19:00Z), yesterday = 2026-06-14 local.
 */
const NOW = new Date('2026-06-15T10:00:00Z');
const AS_OF = '2026-06-15';
// Same scheme as apps/api/test/unique-phone.ts (9-digit random space); inlined because test/ is outside tsconfig rootDir (src).
const uniquePhone = (): string => `+998${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
const iso = (s: string) => new Date(s);

describe('F7.6 golden: dashboard compute + /receivables aging (real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const aging = new AgingReportService(tenantPrisma);
  const dashboard = new DashboardService(tenantPrisma, aging, new ReportConcurrencyLimiter());
  let companyId = '';
  const nameById = new Map<string, string>();
  let prevTtl: string | undefined;

  const inCtx = <T>(fn: () => Promise<T>) => TenantContext.run(handlerScopeStore(companyId), fn);
  const jsonify = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));
  const named = (id: string) => nameById.get(id) ?? `?${id}`;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `golden-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Golden' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Golden Co', timezone: 'Asia/Tashkent' } });
    companyId = company.id;

    await tenantPrisma.run(companyId, async (tx) => {
      const role = await tx.role.create({ data: { companyId, code: 'SALES_AGENT', name: 'Agent', isSystem: true } });
      const agents: Record<string, string> = {};
      for (const [key, first] of [['A1', 'Anvar'], ['A2', 'Bobur']] as const) {
        const u = await tx.user.create({ data: { companyId, firstName: first, lastName: 'Agent', phone: uniquePhone() } });
        await tx.userRole.create({ data: { userId: u.id, roleId: role.id } });
        agents[key] = u.id;
        nameById.set(u.id, first);
      }
      const wh = await tx.warehouse.create({ data: { companyId, name: 'WH' } });
      const cat = await tx.productCategory.create({ data: { companyId, name: 'C' } });
      const prod = await tx.product.create({ data: { companyId, categoryId: cat.id, sku: `G-${randomUUID().slice(0, 8)}`, name: 'P', baseUnit: 'dona', vatRate: 12 } });
      const pk = await tx.productPackaging.create({ data: { productId: prod.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true } });

      const cust = async (name: string, term: number) => {
        const c = await tx.customer.create({ data: { companyId, code: `G-${randomUUID().slice(0, 8)}`, name, paymentTermDays: term } });
        nameById.set(c.id, name);
        return c;
      };
      let seq = 0;
      const num = (p: string) => `${p}-G-${++seq}-${randomUUID().slice(0, 6)}`;
      const inv = (customerId: string, total: string, createdAt: string, status: InvoiceStatus = InvoiceStatus.OPEN, kind: InvoiceKind = InvoiceKind.SALE) =>
        tx.invoice.create({ data: { companyId, number: num('INV'), customerId, total, status, kind, createdAt: iso(createdAt) } });
      const pay = (customerId: string, amount: string, createdAt: string, status: PaymentStatus, extra: { handoverAt?: string; source?: PaymentSource; collectedBy?: string } = {}) =>
        tx.payment.create({
          data: { companyId, number: num('PAY'), customerId, amount, method: PaymentMethod.CASH, status, source: extra.source ?? PaymentSource.COLLECTION, ...(extra.collectedBy ? { collectedBy: extra.collectedBy } : {}), createdAt: iso(createdAt), ...(extra.handoverAt ? { handoverAt: iso(extra.handoverAt) } : {}) },
        });
      const alloc = (paymentId: string, invoiceId: string, amount: string, createdAt: string) =>
        tx.paymentAllocation.create({ data: { paymentId, invoiceId, amount, createdAt: iso(createdAt) } });

      // 13 debtors (+ D14 advance-only). Names sort D01 < D02 < ... so ties break by name.
      const d = {} as Record<string, { id: string }>;
      const terms: Record<string, number> = { D01: 0, D02: 10, D03: 0, D04: 0, D05: 7, D06: 14, D07: 30, D08: 0, D09: 0, D10: 0, D11: 30, D12: 0, D13: 0, D14: 0 };
      for (const n of Object.keys(terms)) d[n] = await cust(n, terms[n]!);

      await inv(d.D01!.id, '1000000.00', '2026-03-01T08:00:00Z'); // 106 days past due -> 60+
      await inv(d.D02!.id, '900000.50', '2026-05-01T08:00:00Z'); // due 05-11, 35d -> 31-60
      await inv(d.D03!.id, '800000.00', '2026-05-20T08:00:00Z'); // 26d -> 8-30 (tie with D04 on total)
      await inv(d.D04!.id, '800000.00', '2026-06-10T08:00:00Z'); // 5d -> 1-7
      await inv(d.D05!.id, '700000.00', '2026-06-15T05:00:00Z'); // due 06-22 -> current
      const i6 = await inv(d.D06!.id, '600000.00', '2026-05-25T08:00:00Z', InvoiceStatus.PARTIALLY_PAID); // due 06-08, 7d -> 1-7 boundary
      const p6 = await pay(d.D06!.id, '250000.25', '2026-06-14T10:00:00Z', PaymentStatus.POSTED);
      await alloc(p6.id, i6.id, '250000.25', '2026-06-14T10:00:00Z');
      const i7 = await inv(d.D07!.id, '500000.00', '2026-04-10T08:00:00Z'); // due 05-10, 36d -> 31-60
      const p7 = await pay(d.D07!.id, '500000.00', '2026-06-14T10:00:00Z', PaymentStatus.POSTED); // DB: cannot insert REVERSED directly
      await alloc(p7.id, i7.id, '500000.00', '2026-06-14T10:00:00Z');
      await tx.paymentReversal.create({ data: { companyId, reversesPaymentId: p7.id, reason: 'golden', actorId: agents.A1!, createdAt: iso('2026-06-15T03:00:00Z') } });
      await tx.payment.update({ where: { id: p7.id }, data: { status: PaymentStatus.REVERSED } });
      // D08: invoice at local 06-15 00:30 (day boundary, today); PENDING_HANDOVER payment (DB forbids allocating it; debt stays full)
      await/*i8*/  await inv(d.D08!.id, '400000.00', '2026-06-14T19:30:00Z');
      await pay(d.D08!.id, '100000.00', '2026-06-15T04:00:00Z', PaymentStatus.PENDING_HANDOVER, { collectedBy: agents.A1! });
      // D09: invoice at local 06-14 23:59:59 (yesterday); REJECTED payment (no allocation possible)
      await/*i9*/  await inv(d.D09!.id, '300000.00', '2026-06-14T18:59:59Z');
      const p9 = await pay(d.D09!.id, '50000.00', '2026-06-15T04:00:00Z', PaymentStatus.PENDING_HANDOVER, { collectedBy: agents.A1! });
      await tx.payment.update({ where: { id: p9.id }, data: { status: PaymentStatus.REJECTED, handoverActorId: agents.A2!, handoverAt: iso('2026-06-15T05:00:00Z'), handoverRejectReason: 'golden' } });
      // D10: OPENING invoice + OPENING payment (not a collection)
      const batch = await tx.openingBalanceBatch.create({ data: { companyId, kind: 'CUSTOMER_BALANCE', asOfDate: new Date('2026-02-01'), source: 'golden', fileHash: 'golden', createdBy: agents.A1! } });
      const i10 = await tx.invoice.create({ data: { companyId, number: `OB-G-${randomUUID().slice(0, 8)}`, customerId: d.D10!.id, total: '250000.00', status: InvoiceStatus.PARTIALLY_PAID, kind: InvoiceKind.OPENING, openingBatchId: batch.id, createdAt: iso('2026-02-01T08:00:00Z') } });
      const p10 = await tx.payment.create({ data: { companyId, number: `OB-P-${randomUUID().slice(0, 8)}`, customerId: d.D10!.id, amount: '50000.00', status: PaymentStatus.POSTED, source: PaymentSource.OPENING, openingBatchId: batch.id, createdAt: iso('2026-06-15T06:00:00Z') } });
      await alloc(p10.id, i10.id, '50000.00', '2026-06-15T06:00:00Z');
      await tx.openingBalanceBatch.update({ where: { id: batch.id }, data: { debtTotal: '250000.00', creditTotal: '50000.00', rowCount: 2, status: 'POSTED', postedBy: agents.A1!, postedAt: iso('2026-06-15T06:00:00Z') } });
      // D11: CANCELLED invoice (ignored) + live 200000 (ties D10's 200000 at rank 10/11 -> name decides)
      await inv(d.D11!.id, '999999.00', '2026-05-01T08:00:00Z', InvoiceStatus.CANCELLED);
      await inv(d.D11!.id, '200000.00', '2026-06-01T08:00:00Z'); // due 07-01 -> current
      await inv(d.D12!.id, '100000.00', '2026-04-15T08:00:00Z'); // 61d -> 60+ boundary
      await pay(d.D12!.id, '70000.00', '2026-06-15T05:00:00Z', PaymentStatus.POSTED); // advance, unallocated (not netted in aging)
      await inv(d.D13!.id, '90000.00', '2026-04-16T08:00:00Z'); // 60d -> 31-60 boundary
      // D14: advance only; created 18:59:59Z yesterday-local but posted (handover) today-local
      const p14 = await pay(d.D14!.id, '30000.00', '2026-06-14T18:59:59Z', PaymentStatus.PENDING_HANDOVER, { collectedBy: agents.A1! });
      const cs = await tx.cashSession.create({ data: { companyId, userId: agents.A2!, openedAt: iso('2026-06-15T03:00:00Z'), openAmount: '0' } });
      await tx.payment.update({ where: { id: p14.id }, data: { status: PaymentStatus.POSTED, handoverActorId: agents.A2!, handoverAt: iso('2026-06-15T06:00:00Z'), handoverCashSessionId: cs.id } });

      // Orders (turnover). Today window starts exactly 2026-06-14T19:00:00Z.
      const order = (agentId: string | null, status: OrderStatus, createdAt: string, qty: number, delivered: number, price: string, disc: number, lineTotal: string) =>
        tx.salesOrder.create({
          data: {
            companyId, number: num('SO'), customerId: d.D01!.id, agentId, warehouseId: wh.id, status, createdAt: iso(createdAt),
            ...(status === OrderStatus.CANCELLED ? { cancelReason: 'x', cancelledAt: iso(createdAt), cancelledBy: agents.A1! } : {}),
            lines: { create: [{ productId: prod.id, packagingId: pk.id, qty, deliveredQty: delivered, unitPrice: price, discountPct: disc, vatRate: 12, lineTotal }] },
          },
        });
      await order(agents.A1!, OrderStatus.DELIVERED, '2026-06-15T05:00:00Z', 10, 4, '10000', 10, '100800.00'); // PARTIAL delivery: counts 4 of 10
      await order(agents.A1!, OrderStatus.CONFIRMED, '2026-06-14T19:00:00Z', 3, 0, '55555.55', 0, '186666.65'); // exactly local midnight -> today
      await order(agents.A2!, OrderStatus.SUBMITTED, '2026-06-14T18:59:59Z', 2, 0, '100000', 0, '224000.00'); // 1s before -> yesterday
      await order(agents.A2!, OrderStatus.CANCELLED, '2026-06-15T05:00:00Z', 1, 0, '999999', 0, '1119998.88'); // excluded
      await order(agents.A2!, OrderStatus.DRAFT, '2026-06-15T05:00:00Z', 1, 0, '888888', 0, '995554.56'); // excluded
      await order(null, OrderStatus.CLOSED, '2026-05-26T08:00:00Z', 5, 5, '20000', 0, '112000.00'); // inside 30d trend, no agent
      await order(agents.A2!, OrderStatus.CONFIRMED, '2026-05-10T08:00:00Z', 1, 0, '50000', 0, '56000.00'); // before trend start

      // agentsToday: A1 has a Monday route with 2 stops and 1 visit today
      const outlet = await tx.outlet.create({ data: { companyId, customerId: d.D01!.id, name: 'O' } });
      const outlet2 = await tx.outlet.create({ data: { companyId, customerId: d.D02!.id, name: 'O2' } });
      const route = await tx.route.create({ data: { companyId, agentId: agents.A1!, weekday: 1, name: 'Mon' } });
      await tx.routeStop.create({ data: { routeId: route.id, outletId: outlet.id, sortOrder: 1 } });
      await tx.routeStop.create({ data: { routeId: route.id, outletId: outlet2.id, sortOrder: 2 } });
      await tx.visit.create({ data: { companyId, agentId: agents.A1!, outletId: outlet.id, startedAt: iso('2026-06-15T06:00:00Z'), latitude: '41.0', longitude: '69.0', gpsOk: true, outcome: 'ORDERED' } });
      await tx.visit.create({ data: { companyId, agentId: agents.A1!, outletId: outlet.id, startedAt: iso('2026-06-14T18:00:00Z'), latitude: '41.0', longitude: '69.0', gpsOk: true, outcome: 'ORDERED' } }); // yesterday local -> not counted
    });

    prevTtl = process.env.DASHBOARD_CACHE_TTL_S;
    process.env.DASHBOARD_CACHE_TTL_S = '0'; // always compute: golden is about numbers, not caching
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (prevTtl === undefined) delete process.env.DASHBOARD_CACHE_TTL_S;
    else process.env.DASHBOARD_CACHE_TTL_S = prevTtl;
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  type Bk = { current: string; d1to7: string; d8to30: string; d31to60: string; d60plus: string };
  const normRow = (r: { customerId: string; customerName: string; buckets: Bk; total: string }) => ({ name: named(r.customerId), customerName: r.customerName, buckets: r.buckets, total: r.total });

  // ---- EXPECTED (captured from pre-refactor code) ----
  const EXPECTED_TOP10 = [
  {
    "name": "D01",
    "customerName": "D01",
    "buckets": {
      "current": "0",
      "d1to7": "0",
      "d8to30": "0",
      "d31to60": "0",
      "d60plus": "1000000"
    },
    "total": "1000000"
  },
  {
    "name": "D02",
    "customerName": "D02",
    "buckets": {
      "current": "0",
      "d1to7": "0",
      "d8to30": "0",
      "d31to60": "900000.5",
      "d60plus": "0"
    },
    "total": "900000.5"
  },
  {
    "name": "D03",
    "customerName": "D03",
    "buckets": {
      "current": "0",
      "d1to7": "0",
      "d8to30": "800000",
      "d31to60": "0",
      "d60plus": "0"
    },
    "total": "800000"
  },
  {
    "name": "D04",
    "customerName": "D04",
    "buckets": {
      "current": "0",
      "d1to7": "800000",
      "d8to30": "0",
      "d31to60": "0",
      "d60plus": "0"
    },
    "total": "800000"
  },
  {
    "name": "D05",
    "customerName": "D05",
    "buckets": {
      "current": "700000",
      "d1to7": "0",
      "d8to30": "0",
      "d31to60": "0",
      "d60plus": "0"
    },
    "total": "700000"
  },
  {
    "name": "D07",
    "customerName": "D07",
    "buckets": {
      "current": "0",
      "d1to7": "0",
      "d8to30": "0",
      "d31to60": "500000",
      "d60plus": "0"
    },
    "total": "500000"
  },
  {
    "name": "D08",
    "customerName": "D08",
    "buckets": {
      "current": "400000",
      "d1to7": "0",
      "d8to30": "0",
      "d31to60": "0",
      "d60plus": "0"
    },
    "total": "400000"
  },
  {
    "name": "D06",
    "customerName": "D06",
    "buckets": {
      "current": "0",
      "d1to7": "349999.75",
      "d8to30": "0",
      "d31to60": "0",
      "d60plus": "0"
    },
    "total": "349999.75"
  },
  {
    "name": "D09",
    "customerName": "D09",
    "buckets": {
      "current": "0",
      "d1to7": "300000",
      "d8to30": "0",
      "d31to60": "0",
      "d60plus": "0"
    },
    "total": "300000"
  },
  {
    "name": "D10",
    "customerName": "D10",
    "buckets": {
      "current": "0",
      "d1to7": "0",
      "d8to30": "0",
      "d31to60": "0",
      "d60plus": "200000"
    },
    "total": "200000"
  }
];
  const EXPECTED_ALL_ORDER = [
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
  "D07",
  "D08",
  "D06",
  "D09",
  "D10",
  "D11",
  "D12",
  "D13"
];
  const EXPECTED_DASH = {
  "today": {
    "turnover": "226986.65",
    "turnoverChangePct": 1.3,
    "orderCount": 2,
    "orderCountChangePct": 100,
    "collected": "100000",
    "collectedChangePct": -60,
    "overdueDebt": "5440000.25",
    "overdueDebtChangePct": 6.9
  },
  "topDebtors": [
    {
      "name": "D01",
      "customerName": "D01",
      "buckets": {
        "current": "0",
        "d1to7": "0",
        "d8to30": "0",
        "d31to60": "0",
        "d60plus": "1000000"
      },
      "total": "1000000"
    },
    {
      "name": "D02",
      "customerName": "D02",
      "buckets": {
        "current": "0",
        "d1to7": "0",
        "d8to30": "0",
        "d31to60": "900000.5",
        "d60plus": "0"
      },
      "total": "900000.5"
    },
    {
      "name": "D03",
      "customerName": "D03",
      "buckets": {
        "current": "0",
        "d1to7": "0",
        "d8to30": "800000",
        "d31to60": "0",
        "d60plus": "0"
      },
      "total": "800000"
    },
    {
      "name": "D04",
      "customerName": "D04",
      "buckets": {
        "current": "0",
        "d1to7": "800000",
        "d8to30": "0",
        "d31to60": "0",
        "d60plus": "0"
      },
      "total": "800000"
    },
    {
      "name": "D05",
      "customerName": "D05",
      "buckets": {
        "current": "700000",
        "d1to7": "0",
        "d8to30": "0",
        "d31to60": "0",
        "d60plus": "0"
      },
      "total": "700000"
    },
    {
      "name": "D07",
      "customerName": "D07",
      "buckets": {
        "current": "0",
        "d1to7": "0",
        "d8to30": "0",
        "d31to60": "500000",
        "d60plus": "0"
      },
      "total": "500000"
    },
    {
      "name": "D08",
      "customerName": "D08",
      "buckets": {
        "current": "400000",
        "d1to7": "0",
        "d8to30": "0",
        "d31to60": "0",
        "d60plus": "0"
      },
      "total": "400000"
    },
    {
      "name": "D06",
      "customerName": "D06",
      "buckets": {
        "current": "0",
        "d1to7": "349999.75",
        "d8to30": "0",
        "d31to60": "0",
        "d60plus": "0"
      },
      "total": "349999.75"
    },
    {
      "name": "D09",
      "customerName": "D09",
      "buckets": {
        "current": "0",
        "d1to7": "300000",
        "d8to30": "0",
        "d31to60": "0",
        "d60plus": "0"
      },
      "total": "300000"
    },
    {
      "name": "D10",
      "customerName": "D10",
      "buckets": {
        "current": "0",
        "d1to7": "0",
        "d8to30": "0",
        "d31to60": "0",
        "d60plus": "200000"
      },
      "total": "200000"
    }
  ],
  "agentsToday": [
    {
      "agentName": "Anvar Agent",
      "plannedVisits": 2,
      "completedVisits": 1,
      "orderCount": 2,
      "turnover": "226986.65",
      "agentId": "Anvar"
    },
    {
      "agentName": "Bobur Agent",
      "plannedVisits": 0,
      "completedVisits": 0,
      "orderCount": 0,
      "turnover": "0",
      "agentId": "Bobur"
    }
  ],
  "trendLength": 30,
  "trendFirst": "2026-05-17",
  "trendLast": "2026-06-15",
  "trendNonZero": [
    {
      "date": "2026-05-26",
      "turnover": "112000"
    },
    {
      "date": "2026-06-14",
      "turnover": "224000"
    },
    {
      "date": "2026-06-15",
      "turnover": "226986.65"
    }
  ]
};

  it('/receivables aging (asOf fixed): page 1 size 10, full order incl. tie-break, page 2 remainder', async () => {
    const p1 = (await inCtx(() => tenantPrisma.run(companyId, () => aging.getAging({ page: 1, pageSize: 10, asOf: AS_OF })))) as never as { data: never[]; total?: number };
    const j1 = jsonify(p1) as { data: Parameters<typeof normRow>[0][]; asOf: string; timeZone: string };
    expect(j1.asOf).toBe(AS_OF);
    expect(j1.timeZone).toBe('Asia/Tashkent');
    expect(j1.data.map(normRow)).toEqual(EXPECTED_TOP10);
    const p2 = jsonify(await tenantPrisma.run(companyId, () => aging.getAging({ page: 2, pageSize: 10, asOf: AS_OF }))) as { data: Parameters<typeof normRow>[0][] };
    expect([...j1.data, ...p2.data].map((r) => named(r.customerId))).toEqual(EXPECTED_ALL_ORDER);
  });

  it('/receivables aging without asOf equals asOf = company today (06-15)', async () => {
    const a = jsonify(await tenantPrisma.run(companyId, () => aging.getAging({ page: 1, pageSize: 10 }))) as { asOf: string; data: Parameters<typeof normRow>[0][] };
    expect(a.asOf).toBe(AS_OF);
    expect(a.data.map(normRow)).toEqual(EXPECTED_TOP10);
  });

  it('dashboard compute output deep-equals the pre-refactor snapshot', async () => {
    const res = jsonify(await inCtx(() => dashboard.getDashboard())) as Record<string, unknown> & {
      topDebtors: Parameters<typeof normRow>[0][];
      agentsToday: { agentId: string; agentName: string }[];
      turnoverLast30Days: { date: string; turnover: string }[];
      generatedAt: string;
      cached: boolean;
    };
    expect(res.cached).toBe(false);
    const { generatedAt, cached, topDebtors, agentsToday, turnoverLast30Days, ...rest } = res;
    void generatedAt; void cached;
    const agents = agentsToday.map(({ agentId, ...a }) => ({ ...a, agentId: named(agentId) })).sort((x, y) => x.agentName.localeCompare(y.agentName));
    const trend = turnoverLast30Days;
    expect({
      ...rest,
      topDebtors: topDebtors.map((r) => ({ ...normRow(r) })),
      agentsToday: agents,
      trendLength: trend.length,
      trendFirst: trend[0]!.date,
      trendLast: trend[trend.length - 1]!.date,
      trendNonZero: trend.filter((t) => t.turnover !== '0'),
    }).toEqual(EXPECTED_DASH);
  });
});
