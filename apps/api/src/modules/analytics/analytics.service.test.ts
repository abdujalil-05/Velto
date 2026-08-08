import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { InvoiceStatus, OrderStatus, prisma, systemPrisma, VisitOutcome } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { AgentPerformanceReportService } from './agent-performance.service';
import { DashboardService } from './dashboard.service';
import { OverviewReportService } from './overview-report.service';
import { isoWeekday } from './report-utils';
import { SalesReportService } from './sales-report.service';

// isoWeekday() and startOfDay()/endOfDay() (report-utils.ts) all use LOCAL
// time, so a "today" query string built from it must be local too —
// Date#toISOString() gives the UTC date instead, which silently disagrees
// with the local one for part of every day (Tashkent is UTC+5, so from
// 00:00-04:59 local the UTC date is still "yesterday"). Using it here would
// make this test flaky specifically in that window.
function localDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
  async function createCompany(slugPrefix: string) {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `${slugPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Analytics Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Analytics Test Co' } });
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
    opts: { status: OrderStatus; total: string; createdAt?: Date; agentId?: string | null },
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
                qty: '1',
                unitPrice: opts.total,
                vatRate: '0',
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

  describe('OverviewReportService', () => {
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
});
