import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, prisma, systemPrisma, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import type { StorageService } from '../../common/storage/storage.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { DashboardService } from '../analytics/dashboard.service';
import { localDateString } from '../analytics/report-utils';
import { CustomersService } from '../customers/customers.service';
import { CashSessionsService } from '../finance/cash-sessions/cash-sessions.service';
import { PaymentOpeningNotReversibleException } from '../finance/finance-exceptions';
import { PaymentsService } from '../finance/payments/payments.service';
import { AgingReportService } from '../finance/reports/aging-report.service';
import { buildTestWorkbook } from '../import/parsers/test-workbook';
import { Export1cProcessor } from '../integrations/export-1c/export-1c.processor';
import type { Export1cJobData } from '../integrations/export-1c/export-1c.constants';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { StockService } from '../stock/stock.service';
import { OPENING_TX_OPTIONS } from './opening-balances.constants';
import { OpeningBalancesService } from './opening-balances.service';

const CUST_HEADERS = ['customerCode', 'debt', 'credit', 'docRef', 'docDate'];
const STOCK_HEADERS = ['sku', 'warehouseName', 'qty'];
const TZ = 'Asia/Tashkent';
const today = () => localDateString(new Date(), TZ);
const daysAgo = (n: number) => localDateString(new Date(Date.now() - n * 86_400_000), TZ);

/** F6 opening balances (ADR-041..043), real Postgres + RLS + DB triggers. */
describe('OpeningBalancesService (integration)', () => {
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
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-opening-${label}-${Date.now()}-${tag}`, name: `Opening ${label}` } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Opening ${label}` } });
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

  const previewCustomers = async (rows: (string | number | undefined)[][], cid = companyId, user = owner) =>
    run(async () => service.preview('CUSTOMER_BALANCE', await xlsx(CUST_HEADERS, rows), user), cid);
  const previewStock = async (rows: (string | number | undefined)[][]) => run(async () => service.preview('STOCK', await xlsx(STOCK_HEADERS, rows), owner));
  const post = (batchId: string, totals: { debt?: string; credit?: string; qty?: string }, extra: { signOff?: boolean; asOfDate?: string; cid?: string; user?: AuthenticatedUser } = {}) =>
    run(
      () =>
        service.post(
          batchId,
          { asOfDate: extra.asOfDate ?? today(), source: '1C oborotka', controlDebt: totals.debt ?? '0', controlCredit: totals.credit ?? '0', controlQty: totals.qty ?? '0', signOff: extra.signOff ?? true },
          extra.user ?? owner,
        ),
      extra.cid ?? companyId,
    );
  const voidBatch = (batchId: string, reason = 'wrong file') => run(() => service.void(batchId, reason, owner));
  const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: { response?: { code?: string } }) => e.response?.code ?? String(e));

  async function assertBalanceInvariants(codes: string[]) {
    await run(async (tx) => {
      for (const code of codes) {
        const c = await tx.customer.findFirstOrThrow({ where: { code } });
        expect(c.cachedBalance.toFixed(2)).toBe((await customers.getLedger(tx, c.id)).balance.toFixed(2));
      }
    });
  }

  beforeAll(async () => {
    const a = await seedCompany('A');
    companyId = a.companyId;
    owner = a.user;
    const b = await seedCompany('B');
    companyB = b.companyId;
    ownerB = b.user;
    await run(async (tx) => {
      wh1 = (await tx.warehouse.create({ data: { companyId, name: `Main ${tag}` } })).id;
      await tx.warehouse.create({ data: { companyId, name: `Second ${tag}` } });
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('customers: preview writes no ledger; post writes OPENING invoices/payment, cachedBalance = ledger, Σ = debt − credit, aging by docDate, audit', async () => {
    const [c1, c2, c3] = await makeCustomers(`HP${tag}`, 3);
    const p = await previewCustomers([
      [c1, 100.5, undefined, '1C-001', daysAgo(40)],
      [c1, '200', undefined, '1C-002', undefined],
      [c2, undefined, '300.25', undefined, undefined],
      [c3, 50, undefined, '1C-003', daysAgo(3)],
    ]);
    expect(p.invalidCount).toBe(0);
    expect(p.batch.status).toBe('PREVIEWED');
    expect(p.batch.debtTotal.toFixed(2)).toBe('350.50');
    expect(p.batch.creditTotal.toFixed(2)).toBe('300.25');
    expect(await run((tx) => tx.invoice.count({ where: { openingBatchId: p.batch.id } }))).toBe(0);

    const posted = await post(p.batch.id, { debt: '350.5', credit: '300.25' });
    expect(posted.status).toBe('POSTED');
    expect(posted.source).toBe('1C oborotka');

    const { invoices, pays } = await run(async (tx) => ({
      invoices: await tx.invoice.findMany({ where: { openingBatchId: p.batch.id }, orderBy: { number: 'asc' } }),
      pays: await tx.payment.findMany({ where: { openingBatchId: p.batch.id } }),
    }));
    expect(invoices).toHaveLength(3);
    for (const i of invoices) {
      expect(i.kind).toBe('OPENING');
      expect(i.orderId).toBeNull();
      expect(i.number).toMatch(/^OB-\d{4}-\d{6}$/);
    }
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ source: 'OPENING', status: 'POSTED', method: null, collectedBy: null });

    await assertBalanceInvariants([c1!, c2!, c3!]);
    const balances = await Promise.all([c1!, c2!, c3!].map(customerByCode));
    expect(balances.map((c) => c.cachedBalance.toFixed(2))).toEqual(['300.50', '-300.25', '50.00']);
    const sum = balances.reduce((s, c) => s.plus(c.cachedBalance), new Prisma.Decimal(0));
    expect(sum.toFixed(2)).toBe(posted.debtTotal.minus(posted.creditTotal).toFixed(2));

    // Aging counts from the 1C document date: 40 days -> 31..60 bucket.
    const aging = await run(() => new AgingReportService(tenantPrisma).getAllRows(today()));
    const row = aging.rows.find((r) => r.customerId === balances[0]!.id)!;
    expect(row.buckets.d31to60.toFixed(2)).toBe('100.50');

    const audit = await run((tx) => tx.auditLog.findFirst({ where: { action: 'opening.post', entityId: p.batch.id } }));
    expect(audit?.newValue).toMatchObject({ fileHash: p.batch.fileHash, debtTotal: '350.50', creditTotal: '300.25' });

    const drift = await recon.runDetection(companyId, { trigger: 'MANUAL', triggeredById: owner.id });
    expect(drift.balanceFindings).toBe(0);
  });

  it('preview reports row errors (unknown customer, mixed debt/advance, duplicates, comma decimal, existing ledger) and post refuses a file with errors', async () => {
    const [c1, c2, c3, c4] = await makeCustomers(`ER${tag}`, 4);
    const c4row = await customerByCode(c4!);
    await run((tx) => tx.payment.create({ data: { companyId, number: `PAY-T-${tag}`, customerId: c4row.id, amount: 10, method: 'CASH', status: 'POSTED' } }));
    const p = await previewCustomers([
      ['NOPE', 10, undefined, 'D1', undefined], // row 2 unknown
      [c1, 10, undefined, 'D1', undefined], // row 3 mixed
      [c1, undefined, 5, undefined, undefined], // row 4 mixed
      [c2, 10, undefined, 'D9', undefined], // row 5 dup docRef
      [c2, 11, undefined, 'D9', undefined], // row 6 dup docRef
      [c3, '1,5', undefined, 'D1', undefined], // row 7 comma
      [c4, 10, undefined, 'D1', undefined], // row 8 has ledger
    ]);
    expect(p.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(p.errors.every((e) => e.i18n!.every((x) => x.uz && x.ru && x.en))).toBe(true);
    expect(await codeOf(post(p.batch.id, {}))).toBe('OPENING_PREVIEW_HAS_ERRORS');
  });

  it('control totals must match exactly (409), signOff false is 400, re-post 409, two parallel posts -> one wins, no duplicates', async () => {
    const [c1] = await makeCustomers(`TT${tag}`, 1);
    const p = await previewCustomers([[c1, '1000.10', undefined, 'X1', undefined]]);
    expect(await codeOf(post(p.batch.id, { debt: '1000.09' }))).toBe('OPENING_TOTALS_MISMATCH');
    expect(await codeOf(post(p.batch.id, { debt: '1000.10' }, { signOff: false }))).toBe('OPENING_SIGN_OFF_REQUIRED');

    const results = await Promise.all([codeOf(post(p.batch.id, { debt: '1000.10' })), codeOf(post(p.batch.id, { debt: '1000.10' }))]);
    expect(results.sort()).toEqual(['OK', 'OPENING_BATCH_NOT_PREVIEWED']);
    expect(await codeOf(post(p.batch.id, { debt: '1000.10' }))).toBe('OPENING_BATCH_NOT_PREVIEWED');
    expect(await run((tx) => tx.invoice.count({ where: { openingBatchId: p.batch.id } }))).toBe(1);
  });

  it('an abandoned PREVIEWED batch blocks nothing; the stale one then fails with OPENING_CONFLICT', async () => {
    const [c1] = await makeCustomers(`AB${tag}`, 1);
    const stale = await previewCustomers([[c1, 70, undefined, 'A1', undefined]]);
    const fresh = await previewCustomers([[c1, 80, undefined, 'A2', undefined]]);
    expect(fresh.invalidCount).toBe(0);
    expect((await post(fresh.batch.id, { debt: '80' })).status).toBe('POSTED');
    expect(await codeOf(post(stale.batch.id, { debt: '70' }))).toBe('OPENING_CONFLICT');
  });

  it('docDate after asOfDate is refused (400)', async () => {
    const [c1] = await makeCustomers(`DD${tag}`, 1);
    const p = await previewCustomers([[c1, 5, undefined, 'L1', daysAgo(1)]]);
    expect(await codeOf(post(p.batch.id, { debt: '5' }, { asOfDate: daysAgo(2) }))).toBe('OPENING_DOC_DATE_AFTER_AS_OF');
  });

  it('void untouched -> invoices CANCELLED, payment REVERSED, balances 0, then the same file re-imports; touched -> 409; OPENING payment reverse/allocate refused', async () => {
    const [c1, c2] = await makeCustomers(`VD${tag}`, 2);
    const rows = [
      [c1, 120, undefined, 'V1', undefined],
      [c2, undefined, 40, undefined, undefined],
    ];
    const p = await previewCustomers(rows);
    await post(p.batch.id, { debt: '120', credit: '40' });

    const openingPay = await run((tx) => tx.payment.findFirstOrThrow({ where: { openingBatchId: p.batch.id } }));
    await expect(run(() => payments.reverse(openingPay.id, 'nope nope', owner))).rejects.toBeInstanceOf(PaymentOpeningNotReversibleException);
    await expect(run(() => payments.allocate(openingPay.id, { allocations: [] } as never, owner))).rejects.toBeInstanceOf(PaymentOpeningNotReversibleException);

    expect((await voidBatch(p.batch.id)).status).toBe('VOIDED');
    const after = await run(async (tx) => ({
      inv: await tx.invoice.findMany({ where: { openingBatchId: p.batch.id } }),
      pay: await tx.payment.findFirstOrThrow({ where: { openingBatchId: p.batch.id }, include: { reversal: true } }),
    }));
    expect(after.inv.every((i) => i.status === 'CANCELLED')).toBe(true);
    expect(after.pay.status).toBe('REVERSED');
    expect(after.pay.reversal?.reason).toBe('wrong file');
    expect((await customerByCode(c1!)).cachedBalance.toFixed(2)).toBe('0.00');
    expect((await customerByCode(c2!)).cachedBalance.toFixed(2)).toBe('0.00');
    expect(await run((tx) => tx.auditLog.count({ where: { action: 'opening.void', entityId: p.batch.id } }))).toBe(1);

    // Re-import after void (same file content) is allowed.
    const again = await previewCustomers(rows);
    expect(again.invalidCount).toBe(0);
    await post(again.batch.id, { debt: '120', credit: '40' });
    await assertBalanceInvariants([c1!, c2!]);

    // Touched: a collection payment FIFO-allocates to the opening invoice.
    const cust = await customerByCode(c1!);
    await run(() => payments.create({ customerId: cust.id, amount: 20, method: 'TRANSFER' } as never, owner));
    expect(await codeOf(voidBatch(again.batch.id))).toBe('OPENING_BATCH_TOUCHED');
    expect(await codeOf(voidBatch(p.batch.id))).toBe('OPENING_BATCH_NOT_POSTED');
  });

  it('stock: preview/post sets onHand = qty, reserved 0, drift 0; pair with movements is a row error; void untouched restores 0 and re-import works; touched -> 409', async () => {
    const [s1, s2, s3] = await makeProducts(`SK${tag}`, 3);
    const s3id = (await run((tx) => tx.product.findFirstOrThrow({ where: { sku: s3 } }))).id;
    await run(() => stock.receive({ productId: s3id, warehouseId: wh1, qty: 5 }, owner));

    const bad = await previewStock([
      [s3, `Main ${tag}`, 1], // has a RECEIVE already
      [s1, `Main ${tag}`, 2],
      [s1, `Main ${tag}`, 3], // duplicate pair
    ]);
    expect(bad.errors.map((e) => e.row)).toEqual([2, 3, 4]);

    const rows = [
      [s1, `Main ${tag}`, 10.5],
      [s1, `Second ${tag}`, '3.125'],
      [s2, `Main ${tag}`, 7],
    ];
    const p = await previewStock(rows);
    expect(p.invalidCount).toBe(0);
    expect(p.batch.qtyTotal.toFixed(3)).toBe('20.625');
    await post(p.batch.id, { qty: '20.625' });

    const levels = await run((tx) => tx.stockLevel.findMany({ where: { product: { sku: { in: [s1!, s2!] } } } }));
    expect(levels).toHaveLength(3);
    expect(levels.every((l) => l.reserved.isZero())).toBe(true);
    expect(levels.map((l) => l.onHand.toFixed(3)).sort()).toEqual(['10.500', '3.125', '7.000']);
    const drift = await recon.runDetection(companyId, { trigger: 'MANUAL', triggeredById: owner.id });
    expect(drift.stockFindings).toBe(0);

    await voidBatch(p.batch.id);
    const zeroed = await run((tx) => tx.stockLevel.findMany({ where: { product: { sku: { in: [s1!, s2!] } } } }));
    expect(zeroed.every((l) => l.onHand.isZero())).toBe(true);

    const again = await previewStock(rows);
    expect(again.invalidCount).toBe(0);
    await post(again.batch.id, { qty: '20.625' });
    const s2id = (await run((tx) => tx.product.findFirstOrThrow({ where: { sku: s2 } }))).id;
    await run(() => stock.adjust({ productId: s2id, warehouseId: wh1, qty: -1, reason: 'damaged' }, owner));
    expect(await codeOf(voidBatch(again.batch.id))).toBe('OPENING_BATCH_TOUCHED');
  });

  it('stock: two previews of the same pair posted in parallel -> exactly one wins', async () => {
    const [s1] = await makeProducts(`SR${tag}`, 1);
    const a = await previewStock([[s1, `Main ${tag}`, 4]]);
    const b = await previewStock([[s1, `Main ${tag}`, 4]]);
    const results = await Promise.all([codeOf(post(a.batch.id, { qty: '4' })), codeOf(post(b.batch.id, { qty: '4' }))]);
    expect(results.sort()).toEqual(['OK', 'OPENING_CONFLICT']);
    const level = await run((tx) => tx.stockLevel.findFirstOrThrow({ where: { product: { sku: s1 }, warehouseId: wh1 } }));
    expect(level.onHand.toFixed(3)).toBe('4.000');
  });

  it('OPENING docs are not exported to 1C, not counted as collected (dashboard, payments period filter, cash session)', async () => {
    const [c1, c2] = await makeCustomers(`EX${tag}`, 2);
    const dashboardSvc = new DashboardService(tenantPrisma, new AgingReportService(tenantPrisma));
    const collectedBefore = (await run(() => dashboardSvc.getDashboard())).today.collected;
    const cash = new CashSessionsService(tenantPrisma, auditLog);
    await run(() => cash.open({ openAmount: 0 } as never, owner));
    const p = await previewCustomers([
      [c1, 500, undefined, 'E1', undefined],
      [c2, undefined, 600, undefined, undefined],
    ]);
    await post(p.batch.id, { debt: '500', credit: '600' });
    const numbers = await run((tx) => tx.invoice.findMany({ where: { openingBatchId: p.batch.id }, select: { number: true } }));

    const job = await run((tx) =>
      tx.exportJob.create({ data: { companyId, type: '1c', format: 'CSV', periodFrom: new Date(Date.now() - 400 * 86_400_000), periodTo: new Date(Date.now() + 86_400_000) } }),
    );
    const put = vi.fn().mockResolvedValue('k');
    await new Export1cProcessor(tenantPrisma, { putObject: put } as unknown as StorageService).process({ data: { exportJobId: job.id, companyId } } as unknown as Job<Export1cJobData>);
    const csv = (put.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(csv).not.toContain('OB-');
    for (const n of numbers) expect(csv).not.toContain(n.number);

    // The OPENING credit is dated today (asOfDate = today) yet is not "collected today".
    const dashboard = await run(() => dashboardSvc.getDashboard());
    expect(new Prisma.Decimal(dashboard.today.collected).toFixed(2)).toBe(new Prisma.Decimal(collectedBefore).toFixed(2));

    const listed = await run(() => payments.list({ page: 1, pageSize: 100, from: today(), to: today() } as never, owner));
    expect(listed.data.some((x) => x.source === 'OPENING')).toBe(false);
    const openingOnly = await run(() => payments.list({ page: 1, pageSize: 100, source: 'OPENING' } as never, owner));
    expect(openingOnly.data.length).toBeGreaterThan(0);

    const session = await run(() => cash.current(owner));
    expect(new Prisma.Decimal(session.totalCollected).toFixed(2)).toBe('0.00');
  });

  it('tenant B cannot see, post or void company A batches', async () => {
    const [c1] = await makeCustomers(`TB${tag}`, 1);
    const p = await previewCustomers([[c1, 9, undefined, 'T1', undefined]]);
    expect(await codeOf(run(() => service.getById(p.batch.id), companyB))).toBe('OPENING_BATCH_NOT_FOUND');
    expect(await codeOf(post(p.batch.id, { debt: '9' }, { cid: companyB, user: ownerB }))).toBe('OPENING_BATCH_NOT_FOUND');
    expect((await run(() => service.list({ page: 1, pageSize: 100 } as never), companyB)).data).toHaveLength(0);
    // and B's file cannot resolve A's customers
    const fromB = await previewCustomers([[c1, 9, undefined, 'T1', undefined]], companyB, ownerB);
    expect(fromB.invalidCount).toBe(1);
  });
});
