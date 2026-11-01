import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma, prisma, systemPrisma } from '@velto/database';
import type { Job } from 'bullmq';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import type { StorageService } from '../../../common/storage/storage.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../../customers/customers.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { makeOwnerAlerts } from '../../notifications/test-owner-alerts';
import { SalesService } from '../../sales/sales.service';
import { StockService } from '../../stock/stock.service';
import type { Export1cJobData } from './export-1c.constants';
import { Export1cProcessor } from './export-1c.processor';

/**
 * ADR-059 stage C: 1C export consistency, CHARACTERIZATION ONLY (mappingVersion 2 unchanged, no production change).
 * Real Postgres + RLS. All expected values are hand-computed (lineTotal = round_HALF_UP_2dp(qty×price×(1−disc)×(1+vat))).
 *
 * What the exported file carries per line: sku/externalCode, qty (BASE units, InvoiceLine.qty), unitPrice (per BASE unit),
 * lineTotal. It does NOT carry: discount, VAT rate/amount, unit/packaging, net amount, currency per line (XML header
 * hardcodes UZS). Hence for any line with discount or VAT, qty × unitPrice != lineTotal in the file: the file is
 * internally inconsistent unless the reader knows the hidden discount/VAT. Cases marked "MISLEADING" below assert the
 * actual current output on purpose — they are not endorsements of the format.
 */
/** Decimal.toString() form used in the files (no trailing zeros: "100" for 100.00). */
const n = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

interface Case {
  key: string;
  sku: string;
  vat: string;
  price: string;
  packQty: number;
  box?: boolean; // 'box 12' packaging (qtyInBaseUnit 12)
  disc: number;
  baseQty: string; // exported qty (base units)
  lineTotal: string; // exported lineTotal == DB snapshot
  naive: string; // qty × unitPrice rounded HALF_UP 2dp = what a reader of the file would compute
}

const CASES: Case[] = [
  // ADR-059 audit example: 2×100, -10%, VAT 12% -> 200×0.9×1.12 = 201.60; file shows 2 / 100 / 201.60
  { key: 'DISC_VAT', sku: 'C1', vat: '12', price: '100.00', packQty: 2, disc: 10, baseQty: '2', lineTotal: '201.6', naive: '200' },
  // fractional qty: 7.125×333.33 = 2374.97625; ×1.12 = 2659.9734 -> 2659.97 (naive rounds to 2374.98)
  { key: 'FRACTIONAL', sku: 'C2', vat: '12', price: '333.33', packQty: 7.125, disc: 0, baseQty: '7.125', lineTotal: '2659.97', naive: '2374.98' },
  // packaging: 2 × box 12 = 24 base; price per BASE unit; file shows 24 / 100 with no unit => "2 boxes" is unrecoverable
  { key: 'PACKAGING', sku: 'C3', vat: '12', price: '100.00', packQty: 2, box: true, disc: 0, baseQty: '24', lineTotal: '2688', naive: '2400' },
  // HALF_UP: 3×1000.05=3000.15; ×0.95=2850.1425; ×1.15=3277.663875 -> 3277.66
  { key: 'ROUND_A', sku: 'C4', vat: '15', price: '1000.05', packQty: 3, disc: 5, baseQty: '3', lineTotal: '3277.66', naive: '3000.15' },
  // HALF_UP boundary: 0.5×99999.99 = 49999.995 -> 50000.00 (VAT 0, no discount: only case where qty×price == lineTotal)
  { key: 'ROUND_B', sku: 'C5', vat: '0', price: '99999.99', packQty: 0.5, disc: 0, baseQty: '0.5', lineTotal: '50000', naive: '50000' },
];
const DOC_TOTAL = '58827.23'; // 201.60+2659.97+2688.00+3277.66+50000.00 (Σ of rounded lines, = invoice.total)
const NAIVE_SUM = '57975.13'; // 200+2374.98+2400+3000.15+50000 : what Σ(qty×unitPrice) would give

describe('ADR-059 C: 1C export vs Invoice/SalesOrder snapshot (characterization, mappingVersion 2)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customersSvc = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const sales = new SalesService(tenantPrisma, auditLog, customersSvc, stock, new DocumentNumberingService(), new NotificationsService(tenantPrisma, new ConfigService()));

  let companyId: string;
  let invoiceId: string;
  const inTenant = <T>(fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-1c-consist-${Date.now()}-${randomUUID().slice(0, 6)}`, name: 'Export1c Consistency Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Export1c Consistency Co' } })).id;
    const dbUser = await systemPrisma.user.create({ data: { companyId, firstName: 'Con', lastName: 'Sist', phone: '+998900000882' } });
    const user: AuthenticatedUser = { id: dbUser.id, companyId, firstName: 'Con', lastName: 'Sist', roles: ['WAREHOUSE'], permissions: ['orders.update'] };
    const lineInputs: Array<{ productId: string; packagingId: string; qty: number; discountPct: number }> = [];
    let warehouseId = '';
    await inTenant(async () => {
      const tx = tenantPrisma.client;
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'WH' } })).id;
      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      for (const c of CASES) {
        const p = await tx.product.create({ data: { companyId, sku: c.sku, name: `P ${c.sku}`, baseUnit: 'dona', vatRate: c.vat } });
        const unit = await tx.productPackaging.create({ data: { productId: p.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true } });
        const box = c.box ? await tx.productPackaging.create({ data: { productId: p.id, name: 'box 12', qtyInBaseUnit: 12 } }) : null;
        await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: p.id, price: c.price } });
        lineInputs.push({ productId: p.id, packagingId: (box ?? unit).id, qty: c.packQty, discountPct: c.disc });
      }
    });
    for (const l of lineInputs) await inTenant(() => stock.receive({ productId: l.productId, warehouseId, qty: 1000 }, user));
    const customer = (await inTenant(() => customersSvc.create({ code: `CON-${Date.now()}`, name: 'Consistency Customer' }, user))).customer as { id: string };
    const order = await inTenant(() => sales.create({ customerId: customer.id, lines: lineInputs }, user));
    await inTenant(() => sales.confirm(order.id, user));
    const before = await inTenant(() => sales.getById(order.id, user));
    await inTenant(() => sales.deliver(order.id, user, { lines: before.lines.map((l) => ({ lineId: l.id, deliveredQty: l.qty.toString() })) }));
    invoiceId = (await inTenant(() => tenantPrisma.client.invoice.findFirstOrThrow({ where: { orderId: order.id } }))).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function run(format: 'CSV' | 'XML' | 'EXCEL'): Promise<Buffer> {
    const job = await inTenant(() =>
      tenantPrisma.client.exportJob.create({ data: { companyId, type: '1c', format, periodFrom: new Date(Date.now() - 86_400_000), periodTo: new Date(Date.now() + 86_400_000) } }),
    );
    const putObject = vi.fn().mockResolvedValue('k');
    await new Export1cProcessor(tenantPrisma, { putObject } as unknown as StorageService).process({ data: { exportJobId: job.id, companyId } } as unknown as Job<Export1cJobData>);
    return (putObject.mock.calls[0]![0] as { buffer: Buffer }).buffer;
  }

  const dbInvoice = () => inTenant(() => tenantPrisma.client.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { include: { product: true } } } }));
  const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), new Prisma.Decimal(0));

  it('DB snapshot (hand): invoice lines = base qty, price per base unit, VAT rate kept, DISCOUNT NOT STORED on InvoiceLine', async () => {
    const inv = await dbInvoice();
    expect(inv.total.toFixed(2)).toBe(DOC_TOTAL);
    expect(sum(inv.lines.map((l) => l.lineTotal.toString())).toFixed(2)).toBe(DOC_TOTAL);
    for (const c of CASES) {
      const l = inv.lines.find((x) => x.product.sku === c.sku)!;
      expect([l.qty.toString(), l.unitPrice.toFixed(2), l.vatRate.toString(), l.lineTotal.toString()]).toEqual([c.baseQty, c.price, c.vat === '0' ? '0' : c.vat, c.lineTotal]);
      expect('discountPct' in l).toBe(false); // InvoiceLine has no discount column: it lives only in SalesOrderLine
    }
  });

  it('CSV: qty/unitPrice/lineTotal/total == Invoice snapshot, but qty×unitPrice != lineTotal (MISLEADING for discount, VAT, fractional, packaging)', async () => {
    const inv = await dbInvoice();
    const rows = (await run('CSV')).toString('utf8').slice(1).split('\r\n').filter(Boolean).map((r) => r.split(','));
    expect(rows[0]).toEqual(['docType', 'Ид', 'number', 'date', 'partnerCode', 'partnerName', 'sku', 'externalCode', 'qty', 'unitPrice', 'lineTotal', 'total', 'method']);
    const sales1c = rows.filter((r) => r[0] === 'SALE' && r[2] === inv.number);
    expect(sales1c).toHaveLength(CASES.length);
    expect(sum(sales1c.map((r) => r[10]!)).toFixed(2)).toBe(DOC_TOTAL); // Σ lineTotal == doc total (consistent)
    for (const c of CASES) {
      const r = sales1c.find((x) => x[6] === c.sku)!;
      expect([r[8], r[9], r[10], r[11]]).toEqual([c.baseQty, n(c.price), c.lineTotal, DOC_TOTAL]);
      const naive = new Prisma.Decimal(r[8]!).times(r[9]!).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString();
      expect(naive).toBe(c.naive); // what a consumer recomputes from the file
      if (c.key === 'ROUND_B') expect(naive).toBe(r[10]); // only line where the file is self-consistent
      else expect(naive).not.toBe(r[10]); // MISLEADING: qty × unitPrice does not reproduce lineTotal
    }
    // MISLEADING: Σ(qty×unitPrice) of the file != doc total (no VAT/discount column to reconcile)
    expect(sum(sales1c.map((r) => new Prisma.Decimal(r[8]!).times(r[9]!).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString())).toFixed(2)).toBe(NAIVE_SUM);
    // No discount / VAT / unit / currency columns exist at all
    expect(rows[0]!.some((h) => /disc|vat|unit(?!Price)|currency|nds/i.test(h))).toBe(false);
  });

  it('XML: line <Сумма>/<Количество>/<ЦенаЗаЕдиницу> == snapshot; no discount/VAT/unit element; currency hardcoded UZS', async () => {
    const inv = await dbInvoice();
    const xml = (await run('XML')).toString('utf8');
    const doc = xml.split('<Документ>').find((d) => d.includes(`<Номер>${inv.number}</Номер>`))!;
    expect(doc).toContain(`<Сумма>${DOC_TOTAL}</Сумма>\n      <Контрагенты>`); // doc-level sum == invoice.total
    expect(doc).toContain('<Валюта>UZS</Валюта>'); // hardcoded, not from Company/Invoice
    const goods = [...doc.matchAll(/<Товар>([\s\S]*?)<\/Товар>/g)].map((m) => m[1]!);
    expect(goods).toHaveLength(CASES.length);
    const tag = (g: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(g)?.[1];
    for (const c of CASES) {
      const g = goods.find((x) => tag(x, 'Наименование') === `P ${c.sku}`)!;
      expect([tag(g, 'Количество'), tag(g, 'ЦенаЗаЕдиницу'), tag(g, 'Сумма')]).toEqual([c.baseQty, n(c.price), c.lineTotal]);
      // MISLEADING: element set is exactly Ид, Наименование, ЦенаЗаЕдиницу, Количество, Сумма
      expect([...g.matchAll(/<([^/>]+)>/g)].map((m) => m[1]).sort()).toEqual(['Ид', 'Количество', 'Наименование', 'ЦенаЗаЕдиницу', 'Сумма'].sort());
    }
    expect(doc).not.toMatch(/Скидк|НДС|Налог|БазоваяЕдиница|ЕдиницаИзмерения|Ставка/);
    expect(sum([...doc.matchAll(/<Товар>[\s\S]*?<Сумма>([^<]*)<\/Сумма>/g)].map((m) => m[1]!)).toFixed(2)).toBe(DOC_TOTAL);
  });

  it('EXCEL: header-level only (number/date/customer/total/id); NO line detail at all', async () => {
    const inv = await dbInvoice();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await run('EXCEL')) as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Kontragentlar', 'Sotish hujjatlari', "To'lovlar"]);
    const sheet = wb.getWorksheet('Sotish hujjatlari')!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(['Raqam', 'Sana', 'Mijoz', 'Summa', 'Ид']);
    const row = sheet.getRows(2, sheet.rowCount - 1)!.find((r) => r.getCell(1).value === inv.number)!;
    expect(row.getCell(4).value).toBe(DOC_TOTAL); // == invoice.total, string; no line/VAT/discount/unit/currency columns
    expect(row.getCell(5).value).toBe(invoiceId);
  });

  it('SalesOrder snapshot keeps what the export drops: discountPct, packaging, VAT rate (hand values)', async () => {
    const lines = await inTenant(() => tenantPrisma.client.salesOrderLine.findMany({ where: { order: { invoices: { some: { id: invoiceId } } } }, include: { product: true, packaging: true } }));
    const by = (sku: string) => lines.find((l) => l.product.sku === sku)!;
    expect([by('C1').discountPct.toString(), by('C1').vatRate.toString(), by('C1').lineTotal.toString()]).toEqual(['10', '12', '201.6']);
    expect([by('C3').packaging.name, by('C3').packaging.qtyInBaseUnit.toString(), by('C3').qty.toString()]).toEqual(['box 12', '12', '24']);
  });
});
