import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma, prisma, systemPrisma } from '@velto/database';
import type { Job } from 'bullmq';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import type { StorageService } from '../../common/storage/storage.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { buildReportCsv, buildReportXlsx } from '../analytics/report-export';
import { salesReportTable } from '../analytics/report-tables';
import { countedOrderTotalsSql } from '../analytics/report-sql';
import { SalesReportService } from '../analytics/sales-report.service';
import { CustomersService } from '../customers/customers.service';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { InvoicesService } from '../finance/invoices/invoices.service';
import { PaymentsService } from '../finance/payments/payments.service';
import type { Export1cJobData } from '../integrations/export-1c/export-1c.constants';
import { Export1cProcessor } from '../integrations/export-1c/export-1c.processor';
import { NotificationsService } from '../notifications/notifications.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';
import { StockService } from '../stock/stock.service';
import { ORDER_LINE_AMOUNTS_SELECT, orderTotal } from './line-total';
import { SalesService } from './sales.service';

/**
 * ADR-059 golden money flow (TZ §6.5/§6.6/§16.1 P0: 5-line order recomputed server-side, invoice =
 * order snapshot, FIFO 1 payment over 2 invoices, overpay => advance, reversal keeps originals,
 * aging, report filters = export, 1C export). Real Postgres + RLS (app role).
 * EVERY expected value is hand-computed (cross-checked with an independent Python decimal script) —
 * none is produced with line-total.ts. Order of operations per line:
 *   gross = baseQty × price;  discAmt = gross × disc/100;  vatBase = gross − discAmt;
 *   vatAmt = vatBase × vat/100;  lineTotal = round_HALF_UP_2dp(vatBase + vatAmt)  (rounded ONCE)
 *   order total = Σ rounded lines; delivered total = Σ lines recomputed on deliveredQty, rounded once each.
 * JSON note: Prisma.Decimal serialises without trailing zeros ("367500" for 367500.00); `n()` normalises
 * the hand-written 2dp strings the same way.
 */
const n = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const j = <T>(v: T): any => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))); // API wire form (Decimal -> string via toJSON)

interface L {
  sku: string;
  box?: boolean; // packaging "box" (qtyInBaseUnit 12) instead of the default unit
  packQty: number;
  base: string; // packQty × factor
  price: string;
  disc: number;
  vat: string;
  gross: string;
  discAmt: string;
  vatBase: string;
  vatAmt: string;
  lineTotal: string; // 2dp, ordered
  deliver: string; // base qty delivered
  delivered2dp: string; // recomputed on deliver, 2dp ('0.00' = omitted from invoice)
}

const ORDER1: L[] = [
  { sku: 'G1', box: true, packQty: 2.5, base: '30', price: '12500.00', disc: 12.5, vat: '12', gross: '375000', discAmt: '46875', vatBase: '328125', vatAmt: '39375', lineTotal: '367500.00', deliver: '12', delivered2dp: '147000.00' }, // 12×12500=150000; ×0.875=131250; ×1.12=147000
  { sku: 'G2', packQty: 7.125, base: '7.125', price: '333.33', disc: 0, vat: '12', gross: '2374.97625', discAmt: '0', vatBase: '2374.97625', vatAmt: '284.99715', lineTotal: '2659.97', deliver: '4.001', delivered2dp: '1493.69' }, // 2659.9734 -> 2659.97; 4.001×333.33×1.12=1493.6917296
  { sku: 'G3', packQty: 3, base: '3', price: '1000.05', disc: 5, vat: '15', gross: '3000.15', discAmt: '150.0075', vatBase: '2850.1425', vatAmt: '427.521375', lineTotal: '3277.66', deliver: '3', delivered2dp: '3277.66' }, // 3277.663875 -> .66; full delivery keeps snapshot
  { sku: 'G4', packQty: 0.5, base: '0.5', price: '99999.99', disc: 0, vat: '0', gross: '49999.995', discAmt: '0', vatBase: '49999.995', vatAmt: '0', lineTotal: '50000.00', deliver: '0.333', delivered2dp: '33300.00' }, // x.xx5 -> up; 0.333×99999.99=33299.99667 -> 33300.00
  { sku: 'G5', packQty: 1, base: '1', price: '4.46', disc: 0, vat: '12', gross: '4.46', discAmt: '0', vatBase: '4.46', vatAmt: '0.5352', lineTotal: '5.00', deliver: '0', delivered2dp: '0.00' }, // 4.9952 -> 5.00; nothing delivered
];
const ORDER2: L[] = [
  { sku: 'G1', box: true, packQty: 0.25, base: '3', price: '12500.00', disc: 0, vat: '12', gross: '37500', discAmt: '0', vatBase: '37500', vatAmt: '4500', lineTotal: '42000.00', deliver: '3', delivered2dp: '42000.00' },
  { sku: 'G2', packQty: 0.333, base: '0.333', price: '333.33', disc: 12.5, vat: '12', gross: '110.99889', discAmt: '13.87486125', vatBase: '97.12402875', vatAmt: '11.65488345', lineTotal: '108.78', deliver: '0.1', delivered2dp: '32.67' }, // 108.7789122 -> 108.78; 0.1×333.33=33.333; ×0.875×1.12=32.66634
  { sku: 'G3', packQty: 10, base: '10', price: '1000.05', disc: 0, vat: '15', gross: '10000.5', discAmt: '0', vatBase: '10000.5', vatAmt: '1500.075', lineTotal: '11500.58', deliver: '7.5', delivered2dp: '8625.43' }, // 11500.575 -> .58 half-up; 7.5×1000.05×1.15=8625.43125
  { sku: 'G4', packQty: 3, base: '3', price: '99999.99', disc: 12.5, vat: '0', gross: '299999.97', discAmt: '37499.99625', vatBase: '262499.97375', vatAmt: '0', lineTotal: '262499.97', deliver: '3', delivered2dp: '262499.97' },
  { sku: 'G5', packQty: 1.5, base: '1.5', price: '4.46', disc: 0, vat: '12', gross: '6.69', discAmt: '0', vatBase: '6.69', vatAmt: '0.8028', lineTotal: '7.49', deliver: '0.5', delivered2dp: '2.50' }, // 7.4928 -> 7.49; 0.5×4.46×1.12=2.4976 -> 2.50
];
const ORDER1_TOTAL = '423442.63'; // 367500.00+2659.97+3277.66+50000.00+5.00
const ORDER2_TOTAL = '316116.82'; // 42000.00+108.78+11500.58+262499.97+7.49
const INV1_TOTAL = '185071.35'; // 147000.00+1493.69+3277.66+33300.00
const INV2_TOTAL = '313160.57'; // 42000.00+32.67+8625.43+262499.97+2.50
const INVOICED = '498231.92'; // 185071.35+313160.57
const PAY1 = 186071.35; // INV1 + 1000.00: FIFO pays INV1 fully, 1000.00 into INV2
const PAY2 = 312661.07; // INV2 open (312160.57) + 500.50 overpay -> advance 500.50

describe('ADR-059 golden money flow: order -> confirm -> partial deliver -> invoice -> payments -> reversal -> reports -> 1C', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customersSvc = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const docNumbering = new DocumentNumberingService();
  const sales = new SalesService(tenantPrisma, auditLog, customersSvc, stock, docNumbering, new NotificationsService(tenantPrisma, new ConfigService()));
  const payments = new PaymentsService(tenantPrisma, auditLog, customersSvc, docNumbering, makeOwnerAlerts(tenantPrisma));
  const invoices = new InvoicesService(tenantPrisma, customersSvc);
  const aging = new AgingReportService(tenantPrisma);
  const salesReport = new SalesReportService(tenantPrisma);

  let companyId: string;
  let user: AuthenticatedUser;
  let customerId: string;
  const productId = new Map<string, string>();
  const packaging = new Map<string, { unit: string; box?: string }>();
  let order1Id: string;
  let order2Id: string;
  const invoiceId: string[] = [];
  const paymentId: string[] = [];
  const inTenant = <T>(fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-golden-${Date.now()}-${randomUUID().slice(0, 6)}`, name: 'Golden Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Golden Co' } })).id;
    const dbUser = await systemPrisma.user.create({ data: { companyId, firstName: 'Gold', lastName: 'En', phone: '+998900000881' } });
    user = { id: dbUser.id, companyId, firstName: 'Gold', lastName: 'En', roles: ['WAREHOUSE'], permissions: ['orders.update'] };
    const catalog = [['G1', '12', '12500.00'], ['G2', '12', '333.33'], ['G3', '15', '1000.05'], ['G4', '0', '99999.99'], ['G5', '12', '4.46']] as const;
    let warehouseId = '';
    await inTenant(async () => {
      const tx = tenantPrisma.client;
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'Golden WH' } })).id;
      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      for (const [sku, vat, price] of catalog) {
        const p = await tx.product.create({ data: { companyId, sku, name: `Golden ${sku}`, baseUnit: 'dona', vatRate: vat } });
        productId.set(sku, p.id);
        const unit = await tx.productPackaging.create({ data: { productId: p.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true } });
        const entry: { unit: string; box?: string } = { unit: unit.id };
        if (sku === 'G1') entry.box = (await tx.productPackaging.create({ data: { productId: p.id, name: 'box 12', qtyInBaseUnit: 12 } })).id;
        packaging.set(sku, entry);
        await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: p.id, price } });
      }
    });
    for (const id of productId.values()) await inTenant(() => stock.receive({ productId: id, warehouseId, qty: 1000 }, user));
    customerId = ((await inTenant(() => customersSvc.create({ code: `GOLD-${Date.now()}`, name: 'Golden Customer' }, user))).customer as { id: string }).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const createOrder = (lines: L[]) =>
    inTenant(() =>
      sales.create(
        {
          customerId,
          lines: lines.map((l) => {
            const pk = packaging.get(l.sku)!;
            return { productId: productId.get(l.sku)!, packagingId: l.box ? pk.box! : pk.unit, qty: l.packQty, discountPct: l.disc };
          }),
        },
        user,
      ),
    );

  /** Line-level money fields as the API serialises them, checked against the hand table. */
  function expectOrderLines(wire: any, table: L[]) {
    expect(wire.lines).toHaveLength(5);
    for (const l of table) {
      const w = wire.lines.find((x: any) => x.product.sku === l.sku);
      expect(w, l.sku).toBeTruthy();
      expect(w.qty).toBe(n(l.base)); // packQty × factor, exact at 3dp
      expect(w.unitPrice).toBe(n(l.price));
      expect(w.discountPct).toBe(n(String(l.disc)));
      expect(w.vatRate).toBe(n(l.vat));
      expect(w.lineTotal).toBe(n(l.lineTotal));
      // discount amount, VAT base and VAT amount are derivable from the snapshot (exact decimals)
      const gross = new Prisma.Decimal(w.qty).times(w.unitPrice);
      const discAmt = gross.times(w.discountPct).dividedBy(100);
      const vatBase = gross.minus(discAmt);
      const vatAmt = vatBase.times(w.vatRate).dividedBy(100);
      expect(gross.toString()).toBe(l.gross);
      expect(discAmt.toString()).toBe(l.discAmt);
      expect(vatBase.toString()).toBe(l.vatBase);
      expect(vatAmt.toString()).toBe(l.vatAmt);
    }
  }

  it('create: 5-line orders recomputed server-side (wire JSON + DB rows)', async () => {
    const [o1, o2] = [await createOrder(ORDER1), await createOrder(ORDER2)];
    order1Id = o1.id;
    order2Id = o2.id;
    for (const [o, table, total] of [[o1, ORDER1, ORDER1_TOTAL], [o2, ORDER2, ORDER2_TOTAL]] as const) {
      const wire = j(o);
      expect(wire.status).toBe('SUBMITTED');
      expect(wire.total).toBe(n(total));
      expectOrderLines(wire, table);
      // DB rows: exactly 2dp stored, total = sum of stored lines (no re-rounding)
      const rows = await inTenant(() => tenantPrisma.client.salesOrderLine.findMany({ where: { orderId: o.id }, include: { product: true } }));
      for (const l of table) expect(rows.find((r) => r.product.sku === l.sku)!.lineTotal.toFixed(2)).toBe(l.lineTotal);
      expect(rows.reduce((s, r) => s.plus(r.lineTotal), new Prisma.Decimal(0)).toFixed(2)).toBe(total);
    }
  });

  it('confirm: both orders CONFIRMED', async () => {
    for (const id of [order1Id, order2Id]) expect((await inTenant(() => sales.confirm(id, user))).status).toBe('CONFIRMED');
  });

  it('partial deliver -> invoice = delivered snapshot; order total = delivered total = invoice total', async () => {
    for (const [id, table, delivered, k] of [[order1Id, ORDER1, INV1_TOTAL, 0], [order2Id, ORDER2, INV2_TOTAL, 1]] as const) {
      const before = await inTenant(() => sales.getById(id, user));
      const dto = { lines: table.map((l) => ({ lineId: before.lines.find((x) => x.product.sku === l.sku)!.id, deliveredQty: l.deliver })) };
      const done = j(await inTenant(() => sales.deliver(id, user, dto)));
      expect(done.status).toBe('DELIVERED');
      expect(done.total).toBe(n(delivered)); // delivered total, not the ordered one
      for (const l of table) expect(done.lines.find((x: any) => x.product.sku === l.sku).deliveredQty).toBe(n(l.deliver));

      const inv = await inTenant(() => tenantPrisma.client.invoice.findFirstOrThrow({ where: { orderId: id }, include: { lines: { include: { product: true } } } }));
      invoiceId[k] = inv.id;
      expect(inv.total.toFixed(2)).toBe(delivered);
      const delivering = table.filter((l) => l.delivered2dp !== '0.00');
      expect(inv.lines).toHaveLength(delivering.length); // 0-qty line omitted
      for (const l of delivering) {
        const il = inv.lines.find((x) => x.product.sku === l.sku)!;
        expect(il.qty.toString()).toBe(n(l.deliver));
        expect(il.unitPrice.toFixed(2)).toBe(l.price);
        expect(il.vatRate.toString()).toBe(n(l.vat));
        expect(il.lineTotal.toFixed(2)).toBe(l.delivered2dp);
      }
      expect(inv.lines.reduce((s, x) => s.plus(x.lineTotal), new Prisma.Decimal(0)).toFixed(2)).toBe(delivered);

      const wireInv = j(await inTenant(() => invoices.getById(inv.id, user)));
      expect(wireInv.total).toBe(n(delivered));
      expect(wireInv.outstanding).toBe(n(delivered));
      expect(wireInv.paid).toBe('0');
    }
    const cust = await inTenant(() => tenantPrisma.client.customer.findUniqueOrThrow({ where: { id: customerId } }));
    expect(cust.cachedBalance.toFixed(2)).toBe(INVOICED);
  });

  it('payment 1 (FIFO over 2 invoices) then payment 2 (overpay => advance)', async () => {
    const p1 = j(await inTenant(() => payments.create({ customerId, amount: PAY1, method: 'TRANSFER' }, user)));
    paymentId[0] = p1.id;
    expect(p1.advance).toBe('0');
    const open = async (k: number) => j(await inTenant(() => invoices.getById(invoiceId[k]!, user)));
    expect((await open(0)).outstanding).toBe('0'); // oldest invoice first: INV1 paid in full
    expect((await open(1)).paid).toBe('1000'); // remainder 186071.35 − 185071.35
    expect((await open(1)).outstanding).toBe('312160.57'); // 313160.57 − 1000.00

    const p2 = j(await inTenant(() => payments.create({ customerId, amount: PAY2, method: 'TRANSFER' }, user)));
    paymentId[1] = p2.id;
    expect(p2.advance).toBe('500.5'); // 312661.07 − 312160.57
    expect((await open(1)).outstanding).toBe('0');
    const { ledger, cached } = await inTenant(async () => ({
      ledger: await customersSvc.getLedger(tenantPrisma.client, customerId),
      cached: (await tenantPrisma.client.customer.findUniqueOrThrow({ where: { id: customerId } })).cachedBalance,
    }));
    expect(ledger.advance.toFixed(2)).toBe('500.50');
    expect(ledger.balance.toFixed(2)).toBe('-500.50'); // 498231.92 − 498231.92 − 500.50
    expect(cached.toFixed(2)).toBe('-500.50');
    expect((await inTenant(() => aging.getAllRows())).rows.filter((r) => r.customerId === customerId)).toHaveLength(0); // nothing outstanding
  });

  it('reversal keeps originals; invoice open amounts, advance, balance, cachedBalance = ledger, aging', async () => {
    await inTenant(() => payments.reverse(paymentId[0]!, 'golden reversal', user));
    const open = async (k: number) => j(await inTenant(() => invoices.getById(invoiceId[k]!, user)));
    expect((await open(0)).outstanding).toBe(n(INV1_TOTAL)); // 185071.35 reopened
    expect((await open(1)).outstanding).toBe('1000'); // 313160.57 − 312160.57 (payment 2 allocation)

    await inTenant(async () => {
      const tx = tenantPrisma.client;
      const orig = await tx.payment.findUniqueOrThrow({ where: { id: paymentId[0]! }, include: { allocations: true } });
      expect(orig.status).toBe('REVERSED');
      expect(orig.amount.toFixed(2)).toBe('186071.35'); // original row untouched
      expect(orig.allocations.map((a) => a.amount.toFixed(2)).sort()).toEqual(['1000.00', '185071.35']); // original allocations kept
      const ledger = await customersSvc.getLedger(tx, customerId);
      const cust = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      expect(ledger.advance.toFixed(2)).toBe('500.50');
      expect(ledger.balance.toFixed(2)).toBe('185570.85'); // 498231.92 − 312160.57 − 500.50
      expect(cust.cachedBalance.toFixed(2)).toBe(ledger.balance.toFixed(2));
    });

    const row = (await inTenant(() => aging.getAllRows())).rows.find((r) => r.customerId === customerId)!;
    expect(row.total.toString()).toBe('186071.35'); // 185071.35 + 1000.00 (aging ignores the advance)
    const buckets = Object.values(row.buckets).reduce((s, b) => s.plus(b), new Prisma.Decimal(0));
    expect(buckets.toFixed(2)).toBe('186071.35');
  });

  it('report SQL totals == JS totals == hand; CSV/XLSX export carry the same totals', async () => {
    const start = new Date(Date.now() - 86_400_000);
    const end = new Date(Date.now() + 86_400_000);
    await inTenant(async () => {
      const tx = tenantPrisma.client;
      const sqlRows = await tx.$queryRaw<{ id: string; total: Prisma.Decimal }[]>`SELECT t."id", t."total" FROM (${countedOrderTotalsSql(start, end)}) t`;
      const sqlById = new Map(sqlRows.map((r) => [r.id, r.total.toFixed(2)]));
      const orders = await tx.salesOrder.findMany({ include: { lines: { select: ORDER_LINE_AMOUNTS_SELECT } } });
      expect(orders).toHaveLength(2);
      for (const o of orders) expect(orderTotal(o).toFixed(2)).toBe(sqlById.get(o.id)); // JS == SQL per order
      expect(sqlById.get(order1Id)).toBe(INV1_TOTAL);
      expect(sqlById.get(order2Id)).toBe(INV2_TOTAL);
    });

    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const report = await inTenant(() => salesReport.getSalesReport({ from: day(start.getTime()), to: day(end.getTime()) }));
    expect(report.summary.turnover.toFixed(2)).toBe(INVOICED);
    expect(report.summary.orderCount).toBe(2);
    expect(report.summary.avgCheck.toFixed(2)).toBe('249115.96'); // 498231.92 / 2
    expect(report.byDay.reduce((s, d) => s.plus(d.turnover), new Prisma.Decimal(0)).toFixed(2)).toBe(INVOICED);

    const table = salesReportTable(report, new Date());
    const csv = buildReportCsv(table).toString('utf8').split('\r\n');
    expect(csv).toContain(`Aylanma,${INVOICED}`);
    expect(csv).toContain('Buyurtmalar soni,2');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildReportXlsx(table)) as unknown as ExcelJS.Buffer);
    let xlsxTurnover: unknown;
    wb.getWorksheet('Jami')!.eachRow((r) => {
      if (r.getCell(1).value === 'Aylanma') xlsxTurnover = r.getCell(2).value;
    });
    expect(xlsxTurnover).toBe(498231.92);
  });

  it('1C export (CSV + CommerceML XML) values == DB values == hand; reversed payment not exported', async () => {
    const run = async (format: 'CSV' | 'XML') => {
      const job = await inTenant(() =>
        tenantPrisma.client.exportJob.create({ data: { companyId, type: '1c', format, periodFrom: new Date(Date.now() - 86_400_000), periodTo: new Date(Date.now() + 86_400_000) } }),
      );
      const putObject = vi.fn().mockResolvedValue('k');
      await new Export1cProcessor(tenantPrisma, { putObject } as unknown as StorageService).process({ data: { exportJobId: job.id, companyId } } as unknown as Job<Export1cJobData>);
      return (putObject.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf8');
    };

    const dbInvoices = await inTenant(() => tenantPrisma.client.invoice.findMany({ include: { lines: { include: { product: true } } } }));
    const csv = (await run('CSV')).slice(1).split('\r\n').filter(Boolean).map((l) => l.split(','));
    const sales1c = csv.filter((r) => r[0] === 'SALE');
    expect(sales1c).toHaveLength(9); // 4 + 5 invoice lines
    for (const inv of dbInvoices) {
      const rows = sales1c.filter((r) => r[2] === inv.number);
      expect(rows).toHaveLength(inv.lines.length);
      for (const r of rows) {
        const il = inv.lines.find((x) => x.product.sku === r[6])!;
        expect([r[8], r[9], r[10], r[11]]).toEqual([il.qty.toString(), il.unitPrice.toString(), il.lineTotal.toString(), inv.total.toString()]);
      }
    }
    expect([...new Set(sales1c.map((r) => r[11]))].sort()).toEqual([n(INV1_TOTAL), n(INV2_TOTAL)].sort());
    const pays = csv.filter((r) => r[0] === 'PAYMENT');
    expect(pays).toHaveLength(1); // payment 1 is REVERSED
    expect([pays[0]![11], pays[0]![12]]).toEqual(['312661.07', 'TRANSFER']);

    const xml = await run('XML');
    const sums = [...xml.matchAll(/<Сумма>([^<]*)<\/Сумма>/g)].map((m) => m[1]);
    for (const inv of dbInvoices) {
      expect(sums).toContain(inv.total.toString());
      for (const il of inv.lines) expect(sums).toContain(il.lineTotal.toString());
    }
    expect(sums).toContain('312661.07');
    expect(sums).not.toContain('186071.35'); // reversed payment
    for (const l of [...ORDER1, ...ORDER2].filter((x) => x.delivered2dp !== '0.00')) expect(sums).toContain(n(l.delivered2dp));
  });
});
