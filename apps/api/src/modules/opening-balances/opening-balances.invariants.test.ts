import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvoiceStatus, Prisma, prisma, systemPrisma, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import type { StorageService } from '../../common/storage/storage.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { localDateString } from '../analytics/report-utils';
import { OverviewReportService } from '../analytics/overview-report.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { buildTestWorkbook } from '../import/parsers/test-workbook';
import type { Export1cJobData } from '../integrations/export-1c/export-1c.constants';
import { Export1cProcessor } from '../integrations/export-1c/export-1c.processor';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { StockService } from '../stock/stock.service';
import { OPENING_REF_TYPE, OPENING_TX_OPTIONS } from './opening-balances.constants';
import { OpeningBalancesService } from './opening-balances.service';

const CUST_HEADERS = ['customerCode', 'debt', 'credit', 'docRef', 'docDate'];
const STOCK_HEADERS = ['sku', 'warehouseName', 'qty'];
const TZ = 'Asia/Tashkent';
const today = () => localDateString(new Date(), TZ);
const daysAgo = (n: number) => localDateString(new Date(Date.now() - n * 86_400_000), TZ);

/** F6 opening balances P0 invariants (TZ 6.7.1, F-ONB, ADR-041..043) — gaps beyond opening-balances.service.test.ts. Real Postgres + RLS. */
describe('Opening balances invariants (integration)', () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog);
  const numbering = new DocumentNumberingService();
  const storage = { upload: async () => `memory://opening/${randomUUID()}` } as unknown as StorageService;
  const service = new OpeningBalancesService(tenantPrisma, storage, auditLog, customers, stock, numbering);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, numbering);
  const recon = new ReconciliationService(tenantPrisma, auditLog, customers);
  const tag = randomUUID().slice(0, 6);

  let companyId: string;
  let companyB: string;
  let owner: AuthenticatedUser;
  let ownerB: AuthenticatedUser;
  let wh1: string;

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-obinv-${label}-${Date.now()}-${tag}`, name: `ObInv ${label}` } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `ObInv ${label}` } });
    const u = await systemPrisma.user.create({ data: { companyId: company.id, firstName: 'Owner', lastName: label, phone: `+99891${Math.floor(1_000_000 + Math.random() * 8_000_000)}` } });
    return { companyId: company.id, user: { id: u.id, companyId: company.id, firstName: 'Owner', lastName: label, roles: ['OWNER'], permissions: [] } as AuthenticatedUser };
  }

  const run = <T>(fn: (tx: TenantClient) => Promise<T>, cid = companyId) => tenantPrisma.run(cid, fn, OPENING_TX_OPTIONS);
  const xlsx = async (headers: string[], rows: (string | number | undefined)[][]) => ({ buffer: await buildTestWorkbook(headers, rows), format: 'xlsx' as const, fileName: 'opening.xlsx' });
  async function makeCustomers(prefix: string, n: number) {
    await run((tx) => tx.customer.createMany({ data: Array.from({ length: n }, (_, i) => ({ companyId, code: `${prefix}-${i}`, name: `C ${i}` })) }));
    return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  }
  async function makeProducts(prefix: string, n: number) {
    await run((tx) => tx.product.createMany({ data: Array.from({ length: n }, (_, i) => ({ companyId, sku: `${prefix}-${i}`, name: `P ${i}`, baseUnit: 'dona', vatRate: 12 })) }));
    return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  }
  const customerByCode = (code: string) => run((tx) => tx.customer.findFirstOrThrow({ where: { code } }));
  const previewCustomers = async (rows: (string | number | undefined)[][]) => run(async () => service.preview('CUSTOMER_BALANCE', await xlsx(CUST_HEADERS, rows), owner));
  const previewStock = async (rows: (string | number | undefined)[][]) => run(async () => service.preview('STOCK', await xlsx(STOCK_HEADERS, rows), owner));
  const post = (batchId: string, totals: { debt?: string; credit?: string; qty?: string }, cid = companyId, user = owner) =>
    run(
      () => service.post(batchId, { asOfDate: today(), source: '1C oborotka', controlDebt: totals.debt ?? '0', controlCredit: totals.credit ?? '0', controlQty: totals.qty ?? '0', signOff: true }, user),
      cid,
    );
  const voidBatch = (batchId: string, cid = companyId, user = owner) => run(() => service.void(batchId, 'wrong file', user), cid);
  const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: { response?: { code?: string } }) => e.response?.code ?? String(e));
  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v).toFixed(2);

  beforeAll(async () => {
    const a = await seedCompany('A');
    companyId = a.companyId;
    owner = a.user;
    const b = await seedCompany('B');
    companyB = b.companyId;
    ownerB = b.user;
    await run(async (tx) => {
      wh1 = (await tx.warehouse.create({ data: { companyId, name: `Main ${tag}` } })).id;
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('F-ONB aging: OPENING invoices bucket by docDate at the 0/1/7/8/30/31/60/61-day boundaries (current, 1-7, 8-30, 31-60, 60+)', async () => {
    const ages = [0, 1, 7, 8, 30, 31, 60, 61];
    const expectedBucket = ['current', 'd1to7', 'd1to7', 'd8to30', 'd8to30', 'd31to60', 'd31to60', 'd60plus'] as const;
    const codes = await makeCustomers(`AG${tag}`, ages.length);
    const p = await previewCustomers(codes.map((c, i) => [c, 100 + i, undefined, `AG-${i}`, daysAgo(ages[i]!)]));
    expect(p.invalidCount).toBe(0);
    await post(p.batch.id, { debt: p.batch.debtTotal.toFixed(2) });

    const aging = await run(() => new AgingReportService(tenantPrisma).getAllRows(today()));
    for (let i = 0; i < ages.length; i++) {
      const c = await customerByCode(codes[i]!);
      const row = aging.rows.find((r) => r.customerId === c.id)!;
      expect(row, `age ${ages[i]}`).toBeDefined();
      for (const b of ['current', 'd1to7', 'd8to30', 'd31to60', 'd60plus'] as const) {
        expect(D(row.buckets[b]), `age ${ages[i]} bucket ${b}`).toBe(b === expectedBucket[i] ? D(100 + i) : '0.00');
      }
    }
  });

  it('F-ONB FIFO: a collection payment closes the OLDEST OPENING invoice first regardless of file row order', async () => {
    const [c] = await makeCustomers(`FI${tag}`, 1);
    // Newest row first in the file: ordering must follow docDate, not row order.
    const p = await previewCustomers([
      [c, 100, undefined, 'F-NEW', daysAgo(5)],
      [c, 100, undefined, 'F-MID', daysAgo(20)],
      [c, 100, undefined, 'F-OLD', daysAgo(40)],
    ]);
    await post(p.batch.id, { debt: '300' });
    const cust = await customerByCode(c!);
    await run(() => payments.create({ customerId: cust.id, amount: 150, method: 'TRANSFER' } as never, owner));

    const invs = await run((tx) => tx.invoice.findMany({ where: { openingBatchId: p.batch.id }, include: { allocations: true } }));
    const by = Object.fromEntries(invs.map((i) => [i.externalDocRef!, i.allocations.reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0))]));
    expect(D(by['F-OLD']!)).toBe('100.00');
    expect(D(by['F-MID']!)).toBe('50.00');
    expect(D(by['F-NEW']!)).toBe('0.00');
    expect(invs.find((i) => i.externalDocRef === 'F-OLD')!.status).toBe(InvoiceStatus.PAID);
    expect((await customerByCode(c!)).cachedBalance.toFixed(2)).toBe('150.00');
  });

  it('6.7.1 reports: overview totalDebt grows by the OPENING debt, turnover/orderCount unchanged; customer ledger counts OPENING', async () => {
    const [c1, c2] = await makeCustomers(`RP${tag}`, 2);
    const overview = new OverviewReportService(tenantPrisma);
    const before = await run(() => overview.getOverview({} as never));
    const p = await previewCustomers([
      [c1, '777.70', undefined, 'RP-1', daysAgo(2)],
      [c2, undefined, 50, undefined, undefined],
    ]);
    await post(p.batch.id, { debt: '777.7', credit: '50' });
    const after = await run(() => overview.getOverview({} as never));
    expect(D(after.totalDebt.minus(before.totalDebt))).toBe('777.70');
    expect(D(after.turnover)).toBe(D(before.turnover));
    expect(after.orderCount).toBe(before.orderCount);
    const cust1 = await customerByCode(c1!);
    const cust2 = await customerByCode(c2!);
    expect(D(cust1.cachedBalance)).toBe('777.70');
    expect(D(cust2.cachedBalance)).toBe('-50.00');
    const ledger = await run((tx) => customers.getLedger(tx, cust2.id));
    expect(D(ledger.balance)).toBe('-50.00');
  });

  it('6.7.1 stock: OPENING writes ADJUST movements tagged refType=OpeningBalance, onHand = qty, reserved = 0', async () => {
    const [s1] = await makeProducts(`MV${tag}`, 1);
    const p = await previewStock([[s1, `Main ${tag}`, '12.345']]);
    await post(p.batch.id, { qty: '12.345' });
    const prod = await run((tx) => tx.product.findFirstOrThrow({ where: { sku: s1 } }));
    const moves = await run((tx) => tx.stockMovement.findMany({ where: { productId: prod.id, warehouseId: wh1 } }));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: 'ADJUST', refType: OPENING_REF_TYPE, refId: p.batch.id });
    expect(moves[0]!.qty.toFixed(3)).toBe('12.345');
    const level = await run((tx) => tx.stockLevel.findFirstOrThrow({ where: { productId: prod.id, warehouseId: wh1 } }));
    expect(level.onHand.toFixed(3)).toBe('12.345');
    expect(level.reserved.isZero()).toBe(true);
  });

  it('ADR-042 reconciliation: detection after OPENING is clean; fix() restores OPENING-derived values, never zeroes them', async () => {
    const [c] = await makeCustomers(`RC${tag}`, 1);
    const [s] = await makeProducts(`RC${tag}`, 1);
    const pc = await previewCustomers([[c, '420.50', undefined, 'RC-1', daysAgo(9)]]);
    await post(pc.batch.id, { debt: '420.5' });
    const ps = await previewStock([[s, `Main ${tag}`, 33]]);
    await post(ps.batch.id, { qty: '33' });
    const cust = await customerByCode(c!);
    const prod = await run((tx) => tx.product.findFirstOrThrow({ where: { sku: s } }));

    const clean = await recon.runDetection(companyId, { trigger: 'MANUAL', triggeredById: owner.id });
    expect(clean.balanceFindings).toBe(0);
    expect(clean.stockFindings).toBe(0);

    // Simulate drift on top of OPENING-derived rows.
    await run(async (tx) => {
      await tx.customer.update({ where: { id: cust.id }, data: { cachedBalance: 0 } });
      await tx.stockLevel.update({ where: { productId_warehouseId: { productId: prod.id, warehouseId: wh1 } }, data: { onHand: 1 } });
    });
    await recon.runDetection(companyId, { trigger: 'MANUAL', triggeredById: owner.id });
    const findings = await run((tx) =>
      tx.reconciliationFinding.findMany({ where: { status: 'OPEN', OR: [{ customerId: cust.id }, { productId: prod.id }] } }),
    );
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      const r = await run(() => recon.fix(f.id, owner));
      expect(r.outcome).toBe('FIXED');
    }
    expect(D((await customerByCode(c!)).cachedBalance)).toBe('420.50');
    const level = await run((tx) => tx.stockLevel.findFirstOrThrow({ where: { productId: prod.id, warehouseId: wh1 } }));
    expect(level.onHand.toFixed(3)).toBe('33.000');
    expect(level.reserved.isZero()).toBe(true);
  });

  it('F-ONB 1C: OPENING invoices/payments are absent from EXCEL, CSV and XML exports and do not count in recordCount', async () => {
    const [c1, c2, c3] = await makeCustomers(`EC${tag}`, 3);
    const p = await previewCustomers([
      [c1, 500, undefined, 'EC-1', daysAgo(3)],
      [c2, undefined, 600, undefined, undefined],
    ]);
    await post(p.batch.id, { debt: '500', credit: '600' });
    const openNumbers = (await run((tx) => tx.invoice.findMany({ where: { openingBatchId: p.batch.id }, select: { number: true } }))).map((i) => i.number);
    const openPay = await run((tx) => tx.payment.findFirstOrThrow({ where: { openingBatchId: p.batch.id } }));
    const cust3 = await customerByCode(c3!);
    const saleNumber = `INV-SALE-${tag}`;
    await run((tx) =>
      tx.invoice.create({ data: { companyId, number: saleNumber, customerId: cust3.id, total: '1000', status: InvoiceStatus.OPEN } }),
    );

    // Expected = SALE invoices + POSTED COLLECTION payments only; OPENING rows must not add to it.
    const expectedCount =
      (await run((tx) => tx.invoice.count({ where: { kind: 'SALE', status: { not: 'CANCELLED' } } }))) +
      (await run((tx) => tx.payment.count({ where: { source: 'COLLECTION', status: 'POSTED' } })));
    expect(await run((tx) => tx.invoice.count({ where: { kind: 'OPENING' } }))).toBeGreaterThan(0);

    const exportAs = async (format: 'EXCEL' | 'CSV' | 'XML') => {
      const job = await run((tx) =>
        tx.exportJob.create({ data: { companyId, type: '1c', format, periodFrom: new Date(Date.now() - 400 * 86_400_000), periodTo: new Date(Date.now() + 86_400_000) } }),
      );
      const put = vi.fn().mockResolvedValue('k');
      await new Export1cProcessor(tenantPrisma, { putObject: put } as unknown as StorageService).process({ data: { exportJobId: job.id, companyId } } as unknown as Job<Export1cJobData>);
      const done = await run((tx) => tx.exportJob.findUniqueOrThrow({ where: { id: job.id } }));
      const buffer = (put.mock.calls[0]![0] as { buffer: Buffer }).buffer;
      let text: string;
      if (format === 'EXCEL') {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer as never);
        const parts: string[] = [];
        wb.eachSheet((ws) => ws.eachRow((row) => parts.push(JSON.stringify(row.values))));
        text = parts.join('\n');
      } else {
        text = buffer.toString('utf-8');
      }
      return { done, text };
    };

    for (const format of ['EXCEL', 'CSV', 'XML'] as const) {
      const { done, text } = await exportAs(format);
      expect(done.status, format).toBe('GENERATED');
      expect(done.recordCount, format).toBe(expectedCount);
      expect(text, format).toContain(saleNumber);
      for (const n of openNumbers) expect(text, `${format} ${n}`).not.toContain(n);
      expect(text, `${format} payment`).not.toContain(openPay.number);
      expect(text, `${format} OB-`).not.toMatch(/OB-\d{4}-\d{6}/);
    }
  });

  it('void: touched by FIFO allocation -> 409 OPENING_BATCH_TOUCHED and ledger unchanged; untouched batch voids back to the original ledger', async () => {
    const [c1, c2] = await makeCustomers(`VT${tag}`, 2);
    const p1 = await previewCustomers([[c1, 200, undefined, 'VT-1', daysAgo(4)]]);
    await post(p1.batch.id, { debt: '200' });
    const cust1 = await customerByCode(c1!);
    await run(() => payments.create({ customerId: cust1.id, amount: 60, method: 'CASH' } as never, owner));
    expect(await codeOf(voidBatch(p1.batch.id))).toBe('OPENING_BATCH_TOUCHED');
    expect(D((await customerByCode(c1!)).cachedBalance)).toBe('140.00');
    expect((await run((tx) => tx.invoice.findFirstOrThrow({ where: { openingBatchId: p1.batch.id } }))).status).not.toBe('CANCELLED');

    const p2 = await previewCustomers([[c2, 90, undefined, 'VT-2', daysAgo(4)]]);
    await post(p2.batch.id, { debt: '90' });
    await voidBatch(p2.batch.id);
    const cust2 = await customerByCode(c2!);
    expect(D(cust2.cachedBalance)).toBe('0.00');
    expect(D((await run((tx) => customers.getLedger(tx, cust2.id))).balance)).toBe('0.00');
    // After void the customer has no live ledger rows again, so a different file imports.
    const again = await previewCustomers([[c2, 91, undefined, 'VT-2B', undefined]]);
    expect(again.invalidCount).toBe(0);
  });

  it('parallel (N=4): two posts of one batch and two of one pair-conflicting stock batch -> exactly one winner each, no duplicates, no deadlock', async () => {
    const [c] = await makeCustomers(`PR${tag}`, 1);
    const [s] = await makeProducts(`PR${tag}`, 1);
    const pc = await previewCustomers([[c, 11, undefined, 'PR-1', undefined]]);
    const sa = await previewStock([[s, `Main ${tag}`, 5]]);
    const sb = await previewStock([[s, `Main ${tag}`, 5]]);
    const results = await Promise.all([
      codeOf(post(pc.batch.id, { debt: '11' })),
      codeOf(post(pc.batch.id, { debt: '11' })),
      codeOf(post(sa.batch.id, { qty: '5' })),
      codeOf(post(sb.batch.id, { qty: '5' })),
    ]);
    expect(results.slice(0, 2).sort()).toEqual(['OK', 'OPENING_BATCH_NOT_PREVIEWED']);
    expect(results.slice(2).sort()).toEqual(['OK', 'OPENING_CONFLICT']);
    expect(await run((tx) => tx.invoice.count({ where: { openingBatchId: pc.batch.id } }))).toBe(1);
    const prod = await run((tx) => tx.product.findFirstOrThrow({ where: { sku: s } }));
    const moves = await run((tx) => tx.stockMovement.count({ where: { productId: prod.id, refType: OPENING_REF_TYPE } }));
    expect(moves).toBe(1);
  });

  it('tenant isolation: B cannot see A OPENING invoices/payments/stock, nor void the batch; A batch stays POSTED', async () => {
    const [c] = await makeCustomers(`TI${tag}`, 1);
    const p = await previewCustomers([
      [c, 300, undefined, 'TI-1', undefined],
    ]);
    await post(p.batch.id, { debt: '300' });
    expect(await run((tx) => tx.invoice.count({ where: { openingBatchId: p.batch.id } }), companyB)).toBe(0);
    expect(await run((tx) => tx.payment.count({ where: { source: 'OPENING' } }), companyB)).toBe(0);
    expect(await run((tx) => tx.openingBalanceBatch.count(), companyB)).toBe(0);
    expect(await codeOf(voidBatch(p.batch.id, companyB, ownerB))).toBe('OPENING_BATCH_NOT_FOUND');
    expect((await run(() => service.getById(p.batch.id))).batch.status).toBe('POSTED');
    expect(await run((tx) => tx.invoice.count({ where: { openingBatchId: p.batch.id, status: 'CANCELLED' } }))).toBe(0);
  });
});
