import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { InvoiceStatus, OrderStatus, PaymentMethod, PaymentStatus, prisma, systemPrisma, VisitOutcome } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import ExcelJS from 'exceljs';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { buildReportCsv, buildReportXlsx, xlsxHeaderRow } from './report-export';
import { agentPerformanceTable, overviewReportTable, salesReportTable } from './report-tables';
import { AgentPerformanceReportService } from './agent-performance.service';
import { DashboardService } from './dashboard.service';
import { OverviewReportService } from './overview-report.service';
import { eachCompanyDay, isoWeekday, localDateString, resolveDateRange } from './report-utils';
import { SalesReportService } from './sales-report.service';


describe('Analytics reports (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const salesReport = new SalesReportService(tenantPrisma);
  const agentPerformance = new AgentPerformanceReportService(tenantPrisma);
  const overview = new OverviewReportService(tenantPrisma);
  const dashboard = new DashboardService(tenantPrisma, new AgingReportService(tenantPrisma));

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  // Each test gets its own tenant/company so aggregate assertions (turnover
  // totals, active-customer counts, ...) aren't polluted by other tests'
  // fixtures sharing the same RLS-scoped company.
  async function createCompany(slugPrefix: string, timezone?: string) {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `${slugPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Analytics Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Analytics Test Co', ...(timezone ? { timezone } : {}) } });
    return company.id;
  }

  async function seedBaseFixtures(companyId: string) {
    return tenantPrisma.run(companyId, async (tx) => {
      const role = await tx.role.create({ data: { companyId, code: 'SALES_AGENT', name: 'Agent', isSystem: true } });
      const agent = await tx.user.create({
        data: { companyId, firstName: 'Anvar', lastName: 'Agent', phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
      });
      await tx.userRole.create({ data: { userId: agent.id, roleId: role.id } });

      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Main WH' } });
      const category = await tx.productCategory.create({ data: { companyId, name: 'Test Category' } });
      const product = await tx.product.create({
        data: { companyId, categoryId: category.id, sku: `SKU-${randomUUID().slice(0, 8)}`, name: 'Test Product', baseUnit: 'dona', vatRate: 12 },
      });
      const packaging = await tx.productPackaging.create({
        data: { productId: product.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true },
      });

      const customer = await tx.customer.create({
        data: { companyId, code: `C-${randomUUID().slice(0, 8)}`, name: 'Test Customer', paymentTermDays: 0 },
      });
      const outlet = await tx.outlet.create({ data: { companyId, customerId: customer.id, name: 'Main Outlet' } });

      const weekday = isoWeekday(new Date());
      const route = await tx.route.create({ data: { companyId, agentId: agent.id, weekday, name: 'Today Route' } });
      await tx.routeStop.create({ data: { routeId: route.id, outletId: outlet.id, sortOrder: 1 } });

      return {
        agentId: agent.id,
        warehouseId: warehouse.id,
        productId: product.id,
        packagingId: packaging.id,
        customerId: customer.id,
        outletId: outlet.id,
      };
    });
  }

  async function createOrder(
    companyId: string,
    fx: Awaited<ReturnType<typeof seedBaseFixtures>>,
    opts: {
      status: OrderStatus;
      total: string;
      createdAt?: Date;
      agentId?: string | null;
      /** F2.4 line snapshot overrides; default is qty 1 × total, 0% discount/VAT. */
      line?: { qty: string; deliveredQty: string; unitPrice: string; discountPct: string; vatRate: string };
    },
  ) {
    return tenantPrisma.run(companyId, (tx) =>
      tx.salesOrder.create({
        data: {
          companyId,
          number: `SO-TEST-${randomUUID()}`,
          customerId: fx.customerId,
          agentId: opts.agentId === undefined ? fx.agentId : opts.agentId,
          warehouseId: fx.warehouseId,
          status: opts.status,
          createdAt: opts.createdAt,
          lines: {
            create: [
              {
                productId: fx.productId,
                packagingId: fx.packagingId,
                qty: opts.line?.qty ?? '1',
                deliveredQty: opts.line?.deliveredQty ?? '0',
                unitPrice: opts.line?.unitPrice ?? opts.total,
                discountPct: opts.line?.discountPct ?? '0',
                vatRate: opts.line?.vatRate ?? '0',
                lineTotal: opts.total,
              },
            ],
          },
        },
      }),
    );
  }

  describe('SalesReportService', () => {
    it('only counts orders past DRAFT and excludes CANCELLED', async () => {
      const companyId = await createCompany('sales-report');
      const fx = await seedBaseFixtures(companyId);

      await createOrder(companyId, fx, { status: OrderStatus.DRAFT, total: '999999' });
      await createOrder(companyId, fx, { status: OrderStatus.CANCELLED, total: '999999' });
      await createOrder(companyId, fx, { status: OrderStatus.SUBMITTED, total: '100000' });
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '50000' });

      const report = await tenantPrisma.run(companyId, () => salesReport.getSalesReport({}));
      expect(report.summary.orderCount).toBe(2);
      expect(report.summary.turnover.toString()).toBe('150000');
      expect(report.byAgent.find((a) => a.agentId === fx.agentId)?.turnover.toString()).toBe('150000');
      expect(report.topProducts.find((p) => p.productId === fx.productId)?.turnover.toString()).toBe('150000');
    });
  });

  describe('F2.4: DELIVERED/CLOSED orders count the delivered amount (= invoice total)', () => {
    it('sales report, agent performance, overview and dashboard all use orderTotal()', async () => {
      const companyId = await createCompany('delivered-amount');
      const fx = await seedBaseFixtures(companyId);

      // Ordered 4 × 33333.33, −10%, +12% VAT = 134399.99 (snapshot); delivered 1
      // → 33333.33 × 0.9 × 1.12 = 33599.99664 → 33600.00 (half-up, as invoice).
      await createOrder(companyId, fx, {
        status: OrderStatus.DELIVERED,
        total: '134399.99',
        line: { qty: '4', deliveredQty: '1', unitPrice: '33333.33', discountPct: '10', vatRate: '12' },
      });
      // Fully delivered CLOSED order keeps its snapshot lineTotal.
      await createOrder(companyId, fx, {
        status: OrderStatus.CLOSED,
        total: '20000',
        line: { qty: '2', deliveredQty: '2', unitPrice: '10000', discountPct: '0', vatRate: '0' },
      });
      // Not yet delivered: ordered amount (deliveredQty is still 0).
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '50000' });

      const expected = '103600';
      const sales = await tenantPrisma.run(companyId, () => salesReport.getSalesReport({}));
      expect(sales.summary.turnover.toString()).toBe(expected);
      expect(sales.byAgent.find((a) => a.agentId === fx.agentId)?.turnover.toString()).toBe(expected);
      expect(sales.topProducts.find((p) => p.productId === fx.productId)?.turnover.toString()).toBe(expected);

      const perf = await tenantPrisma.run(companyId, () => agentPerformance.getAgentPerformance({}));
      expect(perf.agents.find((a) => a.agentId === fx.agentId)?.turnover.toString()).toBe(expected);

      const ov = await tenantPrisma.run(companyId, () => overview.getOverview({}));
      expect(ov.turnover.toString()).toBe(expected);

      const dash = await tenantPrisma.run(companyId, () => dashboard.getDashboard());
      expect(dash.today.turnover.toString()).toBe(expected);
      expect(dash.agentsToday.find((a) => a.agentId === fx.agentId)?.turnover.toString()).toBe(expected);
      const todayKey = localDateString(new Date());
      expect(dash.turnoverLast30Days.find((d) => d.date === todayKey)?.turnover.toString()).toBe(expected);
    });
  });

  describe('AgentPerformanceReportService', () => {
    it("computes route completion and effective-visit ratios from today's route/visit data", async () => {
      const companyId = await createCompany('agent-perf');
      const fx = await seedBaseFixtures(companyId);

      await tenantPrisma.run(companyId, (tx) =>
        tx.visit.create({
          data: {
            companyId,
            agentId: fx.agentId,
            outletId: fx.outletId,
            startedAt: new Date(),
            latitude: '41.0',
            longitude: '69.0',
            gpsOk: true,
            outcome: VisitOutcome.ORDERED,
          },
        }),
      );
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '200000' });

      const today = localDateString(new Date());
      const report = await tenantPrisma.run(companyId, () => agentPerformance.getAgentPerformance({ from: today, to: today }));

      const row = report.agents.find((a) => a.agentId === fx.agentId);
      expect(row?.plannedVisits).toBe(1);
      expect(row?.completedVisits).toBe(1);
      expect(row?.routeCompletionPct).toBe(100);
      expect(row?.effectiveVisitPct).toBe(100);
      expect(row?.turnover.toString()).toBe('200000');
    });
  });

  // Invoice 500000 with two allocations of 100000: one POSTED, one REVERSED payment.
  async function seedPaidAndReversed(companyId: string, fx: Awaited<ReturnType<typeof seedBaseFixtures>>) {
    await tenantPrisma.run(companyId, async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          companyId,
          number: `INV-TEST-${randomUUID().slice(0, 8)}`,
          customerId: fx.customerId,
          total: '500000',
          status: InvoiceStatus.PARTIALLY_PAID,
          createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
        },
      });
      for (const status of [PaymentStatus.POSTED, PaymentStatus.REVERSED]) {
        const payment = await tx.payment.create({
          data: {
            companyId,
            number: `PAY-TEST-${randomUUID().slice(0, 8)}`,
            customerId: fx.customerId,
            amount: '100000',
            method: PaymentMethod.CASH,
          },
        });
        await tx.paymentAllocation.create({ data: { paymentId: payment.id, invoiceId: invoice.id, amount: '100000' } });
        // DB triggers: insert POSTED only; REVERSED only after its PaymentReversal row.
        if (status === PaymentStatus.REVERSED) {
          await tx.paymentReversal.create({ data: { companyId, reversesPaymentId: payment.id, reason: 'test', actorId: fx.agentId } });
          await tx.payment.update({ where: { id: payment.id }, data: { status } });
        }
      }
    });
  }

  describe('OverviewReportService', () => {
    it('ignores allocations of REVERSED payments', async () => {
      const companyId = await createCompany('overview-rev');
      const fx = await seedBaseFixtures(companyId);
      await seedPaidAndReversed(companyId, fx);
      const report = await tenantPrisma.run(companyId, () => overview.getOverview({}));
      expect(report.totalDebt.toString()).toBe('400000');
    });

    it('counts active customers from counted orders and aggregates outstanding debt', async () => {
      const companyId = await createCompany('overview');
      const fx = await seedBaseFixtures(companyId);
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '300000' });

      await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.create({
          data: {
            companyId,
            number: 'INV-TEST-OVERVIEW',
            customerId: fx.customerId,
            total: '500000',
            status: InvoiceStatus.OPEN,
            createdAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
          },
        }),
      );

      const report = await tenantPrisma.run(companyId, () => overview.getOverview({}));
      expect(report.activeCustomers).toBe(1);
      expect(report.totalDebt.toString()).toBe('500000');
      // paymentTermDays=0 on the fixture customer, so it's overdue immediately.
      expect(report.overdueDebt.toString()).toBe('500000');
    });
  });

  describe('DashboardService', () => {
    it('excludes REVERSED payments from collected and overdue debt', async () => {
      const companyId = await createCompany('dashboard-rev');
      const fx = await seedBaseFixtures(companyId);
      await seedPaidAndReversed(companyId, fx);
      const result = await tenantPrisma.run(companyId, () => dashboard.getDashboard());
      expect(result.today.collected.toString()).toBe('100000');
      expect(result.today.overdueDebt.toString()).toBe('400000');
    });

    it('reconstructs overdue debt as-of yesterday', async () => {
      const companyId = await createCompany('dashboard');
      const fx = await seedBaseFixtures(companyId);

      // paymentTermDays=0 and created 2 days ago: already overdue "now" AND
      // already overdue "as of yesterday end-of-day" too, so the two
      // reconstructed snapshots should match exactly (0% change).
      await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.create({
          data: {
            companyId,
            number: 'INV-TEST-DASH',
            customerId: fx.customerId,
            total: '120000',
            status: InvoiceStatus.OPEN,
            createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
          },
        }),
      );

      const result = await tenantPrisma.run(companyId, () => dashboard.getDashboard());
      expect(result.today.overdueDebt.toString()).toBe('120000');
      expect(result.today.overdueDebtChangePct).toBe(0);
    });
  });

  describe('F5.4: export == endpoint (same DTO, same service, same rows)', () => {
    const generatedAt = new Date('2026-08-10T10:00:00Z');

    async function setup() {
      const companyId = await createCompany('export-parity');
      const fx = await seedBaseFixtures(companyId);
      const day = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '50000', createdAt: day(3) });
      await createOrder(companyId, fx, {
        status: OrderStatus.DELIVERED,
        total: '134399.99',
        createdAt: day(2),
        line: { qty: '4', deliveredQty: '1', unitPrice: '33333.33', discountPct: '10', vatRate: '12' },
      });
      await createOrder(companyId, fx, { status: OrderStatus.CANCELLED, total: '77777', createdAt: day(2) });
      await createOrder(companyId, fx, { status: OrderStatus.SUBMITTED, total: '12000', createdAt: day(40) }); // outside window
      const query = { from: localDateString(day(5)), to: localDateString(day(1)) };
      return { companyId, query };
    }

    function parseCsv(buf: Buffer): string[][] {
      expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      return buf.toString('utf8').slice(1).trimEnd().split('\r\n').map((l) => l.split(','));
    }
    const fmt = (v: unknown) => (typeof v === 'object' && v !== null ? (v as { toFixed(n: number): string }).toFixed(2) : String(v ?? ''));

    it('sales: XLSX and CSV sections equal the endpoint rows; delivered-qty amount kept (F2.4)', async () => {
      const { companyId, query } = await setup();
      const report = await tenantPrisma.run(companyId, () => salesReport.getSalesReport(query));
      const table = salesReportTable(report, generatedAt);
      expect(report.summary.turnover.toString()).toBe('83600'); // 50000 + 33600 (1 delivered of 4), CANCELLED/outside excluded
      expect(table.sections[0]!.rows).toEqual(report.byDay.map((d) => [d.date, d.turnover]));
      expect(table.sections[1]!.rows).toEqual(report.byAgent.map((a) => [a.agentName, a.orderCount, a.turnover]));
      expect(table.meta).toContainEqual(['Davr (dan)', query.from]);
      expect(table.meta).toContainEqual(['Davr (gacha)', query.to]);
      expect(table.meta).toContainEqual(['Yaratilgan vaqt', '2026-08-10 15:00:00 (Asia/Tashkent)']);

      const csv = parseCsv(buildReportCsv(table)).map((r) => r.join(','));
      for (const d of report.byDay) expect(csv).toContain(`${d.date},${d.turnover.toFixed(2)}`);
      expect(csv).toContain(`Aylanma,${report.summary.turnover.toFixed(2)}`);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await buildReportXlsx(table)) as never);
      const days = wb.getWorksheet('Kunlar')!;
      const headerRow = xlsxHeaderRow(table);
      expect(days.getRow(headerRow).values).toEqual([undefined, 'Sana', 'Aylanma']);
      const got: unknown[][] = [];
      days.eachRow((r, n) => {
        if (n > headerRow) got.push((r.values as unknown[]).slice(1));
      });
      expect(got).toEqual(report.byDay.map((d) => [d.date, d.turnover.toNumber()]));
    });

    it('agents: export rows == endpoint rows (CSV)', async () => {
      const { companyId, query } = await setup();
      const report = await tenantPrisma.run(companyId, () => agentPerformance.getAgentPerformance(query));
      const rows = parseCsv(buildReportCsv(agentPerformanceTable(report, generatedAt)));
      const headerIdx = rows.findIndex((r) => r[0] === 'Agent');
      expect(rows.slice(headerIdx + 1)).toEqual(
        report.agents.map((a) => [a.agentName, a.plannedVisits, a.completedVisits, a.routeCompletionPct, a.effectiveVisitPct, a.orderCount, a.turnover, a.avgCheck].map(fmt)),
      );
      expect(report.agents[0]!.turnover.toString()).toBe('83600');
    });

    it('overview: export rows == endpoint values (CSV)', async () => {
      const { companyId, query } = await setup();
      const report = await tenantPrisma.run(companyId, () => overview.getOverview(query));
      const rows = parseCsv(buildReportCsv(overviewReportTable(report, generatedAt)));
      const find = (label: string) => rows.find((r) => r[0] === label)?.[1];
      expect(find('Aylanma')).toBe(report.turnover.toFixed(2));
      expect(find('Buyurtmalar soni')).toBe(String(report.orderCount));
      expect(find('Faol mijozlar')).toBe(String(report.activeCustomers));
      expect(find('Jami qarzdorlik')).toBe(report.totalDebt.toFixed(2));
      expect(report.turnover.toString()).toBe('83600');
    });

    it('CSV escapes quotes/commas/newlines and neutralises formula-leading names', () => {
      const csv = buildReportCsv({
        title: 'T',
        meta: [],
        notes: [],
        sections: [{ name: 'S', columns: [{ header: 'A' }, { header: 'B' }], rows: [['a "q", b\nc', '=SUM(A1)']] }],
      }).toString('utf8');
      expect(csv).toContain('"a ""q"", b\nc",\'=SUM(A1)');
    });
  });

  describe('F5.4: day boundaries follow Company.timezone', () => {
    it('sales byDay buckets and range use the company zone (Pacific/Auckland), not Tashkent', async () => {
      const companyId = await createCompany('tz-nz', 'Pacific/Auckland');
      const fx = await seedBaseFixtures(companyId);
      // 2026-06-29T13:00Z = 2026-06-30 01:00 NZST (UTC+12); in Tashkent it would be 2026-06-29 18:00.
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '1000', createdAt: new Date('2026-06-29T13:00:00Z') });
      // 2026-06-30T11:59Z = 2026-06-30 23:59 NZST: still the 30th. 12:00Z = next local midnight.
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '10', createdAt: new Date('2026-06-30T11:59:00Z') });
      await createOrder(companyId, fx, { status: OrderStatus.CONFIRMED, total: '5', createdAt: new Date('2026-06-30T12:00:00Z') });

      const report = await tenantPrisma.run(companyId, () => salesReport.getSalesReport({ from: '2026-06-30', to: '2026-06-30' }));
      expect(report.timeZone).toBe('Pacific/Auckland');
      expect(report.range.from.toISOString()).toBe('2026-06-29T12:00:00.000Z');
      expect(report.range.to.toISOString()).toBe('2026-06-30T11:59:59.999Z');
      expect(report.byDay.map((d) => [d.date, d.turnover.toString()])).toEqual([['2026-06-30', '1010']]);
    });

    it('resolveDateRange / eachCompanyDay: exact local-midnight bounds and ISO weekday per zone', () => {
      const r = resolveDateRange('2026-06-30', '2026-07-01', 30, 'America/New_York');
      expect(r.start.toISOString()).toBe('2026-06-30T04:00:00.000Z');
      expect(r.end.toISOString()).toBe('2026-07-02T03:59:59.999Z');
      expect(eachCompanyDay(r.start, r.end, 'America/New_York').map((d) => d.date)).toEqual(['2026-06-30', '2026-07-01']);
      expect(isoWeekday(new Date('2026-06-30T03:00:00Z'), 'America/New_York')).toBe(1); // Mon 29 Jun 23:00 NY
      expect(isoWeekday(new Date('2026-06-30T03:00:00Z'), 'Asia/Tashkent')).toBe(2);
    });
  });
});
