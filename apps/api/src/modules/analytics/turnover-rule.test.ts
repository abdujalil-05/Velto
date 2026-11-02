import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { InvoiceKind, InvoiceStatus, OrderStatus, Prisma, prisma, systemPrisma, type TenantClient } from '@velto/database';
import { ReportConcurrencyLimiter } from '../../common/concurrency/report-concurrency.limiter';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { TenantContext, handlerScopeStore } from '../../common/tenant/tenant-context';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { AgentPerformanceReportService } from './agent-performance.service';
import { DashboardService } from './dashboard.service';
import { OverviewReportService } from './overview-report.service';
import { buildReportCsv, buildReportXlsx, xlsxHeaderRow } from './report-export';
import { overviewReportTable, salesReportTable } from './report-tables';
import { SalesReportService } from './sales-report.service';

/**
 * F2.4 / PO decision 2026-11-01: actual turnover = DELIVERED/CLOSED orders at
 * the delivered amount only. SUBMITTED/CONFIRMED/SHIPPED/CANCELLED/DRAFT = 0,
 * CLOSED counted once, partial delivery = deliveredQty part, OPENING invoice
 * never turnover (but stays in debt). Every report/dashboard/export agrees.
 * Turnover date = delivery = the order's SALE invoice createdAt (company tz day).
 */
describe('Turnover rule: DELIVERED/CLOSED at delivered amount (real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const salesReport = new SalesReportService(tenantPrisma);
  const agentPerformance = new AgentPerformanceReportService(tenantPrisma);
  const overview = new OverviewReportService(tenantPrisma);
  const dashboard = new DashboardService(tenantPrisma, new AgingReportService(tenantPrisma), new ReportConcurrencyLimiter());
  const getDash = (companyId: string) => {
    dashboard.clearCache();
    return TenantContext.run(handlerScopeStore(companyId), () => dashboard.getDashboard());
  };
  const sum = (xs: Prisma.Decimal[]) => xs.reduce((s, x) => s.plus(x), new Prisma.Decimal(0));

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function seedCompany(prefix: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Turnover Rule' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Turnover Rule Co' } });
    const companyId = company.id;
    const fx = await tenantPrisma.run(companyId, async (tx) => {
      const role = await tx.role.create({ data: { companyId, code: 'SALES_AGENT', name: 'Agent', isSystem: true } });
      const agent = await tx.user.create({ data: { companyId, firstName: 'T', lastName: 'Agent', phone: `+99891${Math.floor(1_000_000 + Math.random() * 8_000_000)}` } });
      await tx.userRole.create({ data: { userId: agent.id, roleId: role.id } });
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'WH' } });
      const category = await tx.productCategory.create({ data: { companyId, name: 'Cat' } });
      const product = await tx.product.create({ data: { companyId, categoryId: category.id, sku: `SKU-${randomUUID().slice(0, 8)}`, name: 'P', baseUnit: 'dona', vatRate: 12 } });
      const packaging = await tx.productPackaging.create({ data: { productId: product.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true } });
      const customer = await tx.customer.create({ data: { companyId, code: `C-${randomUUID().slice(0, 8)}`, name: 'Cu', paymentTermDays: 0 } });
      return { agentId: agent.id, warehouseId: warehouse.id, productId: product.id, packagingId: packaging.id, customerId: customer.id };
    });
    type Line = { qty: string; deliveredQty: string; unitPrice: string; discountPct?: string; vatRate?: string; lineTotal: string };
    // DELIVERED/CLOSED get one SALE invoice (as deliver() writes) at `invoiceAt` (default now) unless invoiceAt: null.
    // Invoice status PAID keeps these out of open-mode debt; turnover date = SALE invoice createdAt.
    const order = async (status: OrderStatus, l: Line, opts: { createdAt?: Date; invoiceAt?: Date | null } = {}) =>
      tenantPrisma.run(companyId, async (tx) => {
        const o = await tx.salesOrder.create({
          data: {
            companyId, number: `SO-TR-${randomUUID()}`, customerId: fx.customerId, agentId: fx.agentId, warehouseId: fx.warehouseId, status,
            ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
            ...(status === OrderStatus.CANCELLED ? { cancelReason: 'x', cancelledAt: new Date(), cancelledBy: fx.agentId } : {}),
            lines: { create: [{ productId: fx.productId, packagingId: fx.packagingId, qty: l.qty, deliveredQty: l.deliveredQty, unitPrice: l.unitPrice, discountPct: l.discountPct ?? '0', vatRate: l.vatRate ?? '0', lineTotal: l.lineTotal }] },
          },
        });
        const delivered = status === OrderStatus.DELIVERED || status === OrderStatus.CLOSED;
        if (opts.invoiceAt !== null && (delivered || opts.invoiceAt)) await createSaleInvoice(tx, o.id, l.lineTotal, opts.invoiceAt ?? new Date());
        return o;
      });
    const createSaleInvoice = (tx: TenantClient, orderId: string, total: string, createdAt: Date) =>
      tx.invoice.create({ data: { companyId, number: `INV-TR-${randomUUID().slice(0, 8)}`, customerId: fx.customerId, orderId, total, status: InvoiceStatus.PAID, kind: InvoiceKind.SALE, createdAt } });
    const saleInvoice = (orderId: string, total: string, createdAt: Date) =>
      tenantPrisma.run(companyId, (tx) => createSaleInvoice(tx, orderId, total, createdAt));
    return { companyId, fx, order, saleInvoice };
  }

  it('non-delivered statuses = 0; DELIVERED→CLOSED once; partial = delivered part; OPENING not turnover; all reports equal; tenant isolated', async () => {
    const a = await seedCompany('turnover-a');
    // Not turnover (ordered amounts would be 100000 + 50000 + 70000 + 99999 + 11111).
    await a.order(OrderStatus.SUBMITTED, { qty: '1', deliveredQty: '0', unitPrice: '100000', lineTotal: '100000' });
    await a.order(OrderStatus.CONFIRMED, { qty: '1', deliveredQty: '0', unitPrice: '50000', lineTotal: '50000' });
    await a.order(OrderStatus.SHIPPED, { qty: '1', deliveredQty: '0', unitPrice: '70000', lineTotal: '70000' });
    await a.order(OrderStatus.CANCELLED, { qty: '1', deliveredQty: '0', unitPrice: '99999', lineTotal: '99999' });
    await a.order(OrderStatus.DRAFT, { qty: '1', deliveredQty: '0', unitPrice: '11111', lineTotal: '11111' });
    // Turnover: full DELIVERED 20000; DELIVERED later CLOSED 15000; partial 1 of 4 × 33333.33 −10% +12% = 33600.00.
    await a.order(OrderStatus.DELIVERED, { qty: '2', deliveredQty: '2', unitPrice: '10000', lineTotal: '20000' });
    const toClose = await a.order(OrderStatus.DELIVERED, { qty: '3', deliveredQty: '3', unitPrice: '5000', lineTotal: '15000' });
    await a.order(OrderStatus.DELIVERED, { qty: '4', deliveredQty: '1', unitPrice: '33333.33', discountPct: '10', vatRate: '12', lineTotal: '134399.99' });
    // OPENING invoice 250000 (carried-over debt, no order).
    await tenantPrisma.run(a.companyId, async (tx) => {
      const batch = await tx.openingBalanceBatch.create({ data: { companyId: a.companyId, kind: 'CUSTOMER_BALANCE', asOfDate: new Date('2026-01-01'), source: 'test', fileHash: 'test', createdBy: a.fx.agentId } });
      await tx.invoice.create({ data: { companyId: a.companyId, number: `OB-TR-${randomUUID().slice(0, 8)}`, customerId: a.fx.customerId, total: '250000', status: InvoiceStatus.OPEN, kind: InvoiceKind.OPENING, openingBatchId: batch.id } });
      await tx.openingBalanceBatch.update({ where: { id: batch.id }, data: { debtTotal: '250000', creditTotal: '0', rowCount: 1, status: 'POSTED', postedBy: a.fx.agentId, postedAt: new Date() } });
    });
    // Company B: delivered order that must never leak into A.
    const b = await seedCompany('turnover-b');
    await b.order(OrderStatus.DELIVERED, { qty: '1', deliveredQty: '1', unitPrice: '777777', lineTotal: '777777' });

    const EXPECTED = '68600.00'; // 20000 + 15000 + 33600
    const check = async () => {
      const sales = await tenantPrisma.run(a.companyId, () => salesReport.getSalesReport({}));
      expect(sales.summary.turnover.toFixed(2)).toBe(EXPECTED);
      expect(sales.summary.orderCount).toBe(3); // delivered-order count
      expect(sales.summary.avgCheck.toFixed(2)).toBe('22866.67');
      expect(sum(sales.byDay.map((d) => d.turnover)).toFixed(2)).toBe(EXPECTED);
      expect(sum(sales.byAgent.map((x) => x.turnover)).toFixed(2)).toBe(EXPECTED);
      expect(sales.byAgent.reduce((s, x) => s + x.orderCount, 0)).toBe(3);
      expect(sum(sales.topProducts.map((p) => p.turnover)).toFixed(2)).toBe(EXPECTED);

      const ov = await tenantPrisma.run(a.companyId, () => overview.getOverview({}));
      expect(ov.turnover.toFixed(2)).toBe(EXPECTED);
      expect(ov.orderCount).toBe(3);
      expect(ov.activeCustomers).toBe(1);
      expect(ov.totalDebt.toFixed(2)).toBe('250000.00'); // OPENING stays in debt (fixture SALE invoices are PAID)

      const dash = await getDash(a.companyId);
      expect(dash.today.turnover.toFixed(2)).toBe(EXPECTED);
      expect(dash.today.orderCount).toBe(3);
      expect(sum(dash.turnoverLast30Days.map((d) => d.turnover)).toFixed(2)).toBe(EXPECTED);
      const agentToday = dash.agentsToday.find((x) => x.agentId === a.fx.agentId)!;
      expect(agentToday.turnover.toFixed(2)).toBe(EXPECTED);
      expect(agentToday.orderCount).toBe(3);

      const perf = await tenantPrisma.run(a.companyId, () => agentPerformance.getAgentPerformance({}));
      expect(sum(perf.agents.map((x) => x.turnover)).toFixed(2)).toBe(EXPECTED);
      expect(perf.agents.reduce((s, x) => s + x.orderCount, 0)).toBe(3);

      const generatedAt = new Date();
      const salesTable = salesReportTable(sales, generatedAt);
      const csv = buildReportCsv(salesTable).toString('utf8').split('\r\n');
      expect(csv).toContain(`Aylanma,${EXPECTED}`);
      expect(csv).toContain('Buyurtmalar soni,3');
      expect(salesTable.meta).toContainEqual(['Buyurtma holatlari', 'DELIVERED, CLOSED']);
      expect(buildReportCsv(overviewReportTable(ov, generatedAt)).toString('utf8').split('\r\n')).toContain(`Aylanma,${EXPECTED}`);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await buildReportXlsx(salesTable)) as never);
      const days = wb.getWorksheet('Kunlar')!;
      const header = xlsxHeaderRow(salesTable);
      let xlsxTotal = new Prisma.Decimal(0);
      days.eachRow((r, n) => {
        if (n > header) xlsxTotal = xlsxTotal.plus(String((r.values as unknown[])[2]));
      });
      expect(xlsxTotal.toFixed(2)).toBe(EXPECTED);
    };

    await check();
    // Same order DELIVERED → CLOSED: counted once, same totals.
    await tenantPrisma.run(a.companyId, (tx) => tx.salesOrder.update({ where: { id: toClose.id }, data: { status: OrderStatus.CLOSED } }));
    await check();

    // Tenant B sees only its own delivered order.
    const salesB = await tenantPrisma.run(b.companyId, () => salesReport.getSalesReport({}));
    expect(salesB.summary.turnover.toFixed(2)).toBe('777777.00');
    expect(salesB.summary.orderCount).toBe(1);
  });
  it('turnover date = delivery (SALE invoice createdAt), Tashkent day; second SALE invoice per order rejected; no invoice / non-delivered excluded', async () => {
    const c = await seedCompany('turnover-date');
    const line = (amount: string) => ({ qty: '1', deliveredQty: '1', unitPrice: amount, lineTotal: amount });
    // (a) created Oct 31 15:00 Tashkent, delivered Nov 1 11:00 Tashkent -> November only.
    await c.order(OrderStatus.DELIVERED, line('10000'), { createdAt: new Date('2026-10-31T10:00:00Z'), invoiceAt: new Date('2026-11-01T06:00:00Z') });
    // (b) delivered 2026-10-31T19:30Z = Nov 1 00:30 Tashkent -> Nov 1 bucket.
    await c.order(OrderStatus.DELIVERED, line('20000'), { createdAt: new Date('2026-10-31T12:00:00Z'), invoiceAt: new Date('2026-10-31T19:30:00Z') });
    // control: delivered Oct 31 23:00 Tashkent -> October.
    await c.order(OrderStatus.DELIVERED, line('40000'), { createdAt: new Date('2026-10-31T10:00:00Z'), invoiceAt: new Date('2026-10-31T18:00:00Z') });
    // (c)+(f) CLOSED order -> once, on its SALE invoice day (Nov 2). A second SALE
    // invoice for the same order is rejected by the DB (Invoice_sale_orderId_key, 20261102100000).
    const twice = await c.order(OrderStatus.CLOSED, line('80000'), { createdAt: new Date('2026-10-30T06:00:00Z'), invoiceAt: new Date('2026-11-02T06:00:00Z') });
    await expect(c.saleInvoice(twice.id, '80000', new Date('2026-11-05T06:00:00Z'))).rejects.toMatchObject({ code: 'P2002' });
    // (d) non-delivered statuses excluded even with a SALE invoice in the window.
    for (const st of [OrderStatus.SUBMITTED, OrderStatus.CONFIRMED, OrderStatus.SHIPPED, OrderStatus.CANCELLED])
      await c.order(st, { qty: '1', deliveredQty: '0', unitPrice: '5000', lineTotal: '5000' }, { createdAt: new Date('2026-11-01T06:00:00Z'), invoiceAt: new Date('2026-11-03T06:00:00Z') });
    // DELIVERED without a SALE invoice -> excluded (no createdAt fallback).
    await c.order(OrderStatus.DELIVERED, line('3000'), { createdAt: new Date('2026-11-01T06:00:00Z'), invoiceAt: null });
    // (e) OPENING invoice in November -> not turnover.
    await tenantPrisma.run(c.companyId, async (tx) => {
      const batch = await tx.openingBalanceBatch.create({ data: { companyId: c.companyId, kind: 'CUSTOMER_BALANCE', asOfDate: new Date('2026-11-01'), source: 'test', fileHash: 'test', createdBy: c.fx.agentId } });
      await tx.invoice.create({ data: { companyId: c.companyId, number: `OB-TR-${randomUUID().slice(0, 8)}`, customerId: c.fx.customerId, total: '250000', status: InvoiceStatus.OPEN, kind: InvoiceKind.OPENING, openingBatchId: batch.id, createdAt: new Date('2026-11-01T06:00:00Z') } });
    });

    const oct = { from: '2026-10-01', to: '2026-10-31' };
    const nov = { from: '2026-11-01', to: '2026-11-30' };
    const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(c.companyId, fn);

    const sOct = await run(() => salesReport.getSalesReport(oct));
    expect(sOct.summary.turnover.toFixed(2)).toBe('40000.00');
    expect(sOct.summary.orderCount).toBe(1);
    expect(sOct.byDay.find((d) => d.date === '2026-10-31')!.turnover.toFixed(2)).toBe('40000.00');
    expect(sum(sOct.topProducts.map((p) => p.turnover)).toFixed(2)).toBe('40000.00');
    expect(sum(sOct.byAgent.map((x) => x.turnover)).toFixed(2)).toBe('40000.00');

    const sNov = await run(() => salesReport.getSalesReport(nov));
    expect(sNov.summary.turnover.toFixed(2)).toBe('110000.00'); // 10000 + 20000 + 80000
    expect(sNov.summary.orderCount).toBe(3);
    const novDays = new Map(sNov.byDay.map((d) => [d.date, d.turnover.toFixed(2)]));
    expect(novDays.get('2026-11-01')).toBe('30000.00');
    expect(novDays.get('2026-11-02')).toBe('80000.00');
    expect(novDays.get('2026-11-05')).toBe('0.00');
    expect(sum(sNov.byDay.map((d) => d.turnover)).toFixed(2)).toBe('110000.00');
    expect(sum(sNov.topProducts.map((p) => p.turnover)).toFixed(2)).toBe('110000.00');
    expect(sNov.byAgent.reduce((s, x) => s + x.orderCount, 0)).toBe(3);
    expect(buildReportCsv(salesReportTable(sNov, new Date())).toString('utf8').split('\r\n')).toContain('Aylanma,110000.00');

    const ovOct = await run(() => overview.getOverview(oct));
    const ovNov = await run(() => overview.getOverview(nov));
    expect([ovOct.turnover.toFixed(2), ovOct.orderCount]).toEqual(['40000.00', 1]);
    expect([ovNov.turnover.toFixed(2), ovNov.orderCount]).toEqual(['110000.00', 3]);

    const pOct = await run(() => agentPerformance.getAgentPerformance(oct));
    const pNov = await run(() => agentPerformance.getAgentPerformance(nov));
    expect(sum(pOct.agents.map((x) => x.turnover)).toFixed(2)).toBe('40000.00');
    expect(sum(pNov.agents.map((x) => x.turnover)).toFixed(2)).toBe('110000.00');
    expect(pNov.agents.reduce((s, x) => s + x.orderCount, 0)).toBe(3);
  });

  it('dashboard: order created days ago, delivered now -> today bucket only, once', async () => {
    const d = await seedCompany('turnover-dash');
    const created = new Date(Date.now() - 3 * 86_400_000);
    await d.order(OrderStatus.DELIVERED, { qty: '1', deliveredQty: '1', unitPrice: '12345', lineTotal: '12345' }, { createdAt: created });
    const dash = await getDash(d.companyId);
    expect(dash.today.turnover.toFixed(2)).toBe('12345.00');
    expect(dash.today.orderCount).toBe(1);
    expect(sum(dash.turnoverLast30Days.map((x) => x.turnover)).toFixed(2)).toBe('12345.00');
    expect(dash.agentsToday.find((x) => x.agentId === d.fx.agentId)!.turnover.toFixed(2)).toBe('12345.00');
  });
});
