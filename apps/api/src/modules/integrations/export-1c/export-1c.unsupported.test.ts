import { randomUUID, createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { InvoiceStatus, prisma, systemPrisma } from '@velto/database';
import type { StorageService } from '../../../common/storage/storage.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import type { Export1cJobData } from './export-1c.constants';
import { Export1cProcessor } from './export-1c.processor';

/** ADR-059 strict reject: real Postgres + RLS; storage mocked. Hand-computed amounts. */
describe('1C export strict reject (ADR-059)', () => {
  const tenantPrisma = new TenantPrismaService();
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function company() {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-1c-unsup-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Unsupported Tenant' } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Unsupported Co' } })).id;
  }

  type L = { qty: string; unitPrice: string; vatRate?: string; lineTotal: string; disc?: string; box?: number };
  /** Invoice (+ order snapshot when disc/box given, like deliver()) with the given lines. */
  async function seed(companyId: string, docs: Array<{ total?: string; lines: L[] }>) {
    return tenantPrisma.run(companyId, async (tx) => {
      const customer = await tx.customer.create({ data: { companyId, code: `C-${randomUUID().slice(0, 8)}`, name: 'Cust' } });
      const out: { id: string; number: string }[] = [];
      for (const d of docs) {
        const order = await tx.salesOrder.create({ data: { companyId, number: `SO-${randomUUID().slice(0, 8)}`, customerId: customer.id, warehouseId: (await tx.warehouse.create({ data: { companyId, name: 'W' } })).id, status: 'DELIVERED' } });
        const lines = [];
        for (const l of d.lines) {
          const product = await tx.product.create({ data: { companyId, sku: `SKU-${randomUUID().slice(0, 8)}`, name: 'P', baseUnit: 'dona', externalCode: 'X1' } });
          const pk = await tx.productPackaging.create({ data: { productId: product.id, name: 'pk', qtyInBaseUnit: l.box ?? 1, isDefault: true } });
          await tx.salesOrderLine.create({ data: { orderId: order.id, productId: product.id, packagingId: pk.id, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.disc ?? '0', vatRate: l.vatRate ?? '0', lineTotal: l.lineTotal, deliveredQty: l.qty } });
          lines.push({ productId: product.id, qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate ?? '0', lineTotal: l.lineTotal });
        }
        const total = d.total ?? d.lines.reduce((s, l) => s + Number(l.lineTotal), 0).toFixed(2);
        const inv = await tx.invoice.create({ data: { companyId, number: `INV-${randomUUID().slice(0, 8)}`, customerId: customer.id, orderId: order.id, total, status: InvoiceStatus.OPEN, lines: { create: lines } } });
        out.push({ id: inv.id, number: inv.number });
      }
      return out;
    });
  }

  async function run(companyId: string, format: 'XML' | 'CSV' | 'EXCEL', putObject = vi.fn().mockResolvedValue('k'), attempt = { made: 0, max: 3 }) {
    const job = await tenantPrisma.run(companyId, (tx) => tx.exportJob.create({ data: { companyId, type: '1c', format, periodFrom: new Date(Date.now() - 86_400_000), periodTo: new Date(Date.now() + 86_400_000) } }));
    const err = await new Export1cProcessor(tenantPrisma, { putObject } as unknown as StorageService)
      .process({ data: { exportJobId: job.id, companyId }, attemptsMade: attempt.made, opts: { attempts: attempt.max } } as unknown as Job<Export1cJobData>)
      .then(() => null, (e: unknown) => e as Error);
    const saved = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: job.id } }));
    return { err, saved, putObject };
  }
  type Log = { code: string; total: number; violations: Array<{ invoiceId: string; invoiceNumber: string; sku: string | null; reasons: string[] }> };

  it.each([
    ['discount line', { qty: '2', unitPrice: '100', lineTotal: '180', disc: '10' }, ['DISCOUNT', 'QTY_X_PRICE_MISMATCH']],
    ['VAT line', { qty: '2', unitPrice: '100', vatRate: '12', lineTotal: '224' }, ['VAT', 'QTY_X_PRICE_MISMATCH']],
    ['fractional qty, qty x price != lineTotal', { qty: '7.125', unitPrice: '333.33', lineTotal: '2659.97', vatRate: '12' }, ['VAT', 'QTY_X_PRICE_MISMATCH']],
    ['packaging only (arithmetic holds)', { qty: '24', unitPrice: '100', lineTotal: '2400', box: 12 }, ['UNIT']],
  ] as Array<[string, L, string[]]>)('%s: XML+CSV rejected, FAILED, no file, no retry', async (_n, line, reasons) => {
    const c = await company();
    const [inv] = await seed(c, [{ lines: [line] }]);
    for (const format of ['XML', 'CSV'] as const) {
      const { err, saved, putObject } = await run(c, format);
      expect(err?.name).toBe('UnrecoverableError');
      expect(putObject).not.toHaveBeenCalled();
      expect(saved.status).toBe('FAILED');
      expect(saved.attemptCount).toBe(1);
      expect(saved.fileHash).toBeNull();
      const log = saved.errorLog as Log;
      expect(log.code).toBe('1C_EXPORT_UNSUPPORTED_COMBINATION');
      expect(log.violations).toEqual([expect.objectContaining({ invoiceId: inv!.id, invoiceNumber: inv!.number, reasons })]);
    }
  });

  it('total mismatch: Σ lines != Invoice.total -> TOTAL_MISMATCH (document level, sku null)', async () => {
    const c = await company();
    const [inv] = await seed(c, [{ total: '999.00', lines: [{ qty: '1', unitPrice: '100', lineTotal: '100' }] }]);
    const { saved } = await run(c, 'CSV');
    expect(saved.status).toBe('FAILED');
    expect((saved.errorLog as Log).violations).toEqual([{ invoiceId: inv!.id, invoiceNumber: inv!.number, sku: null, reasons: ['TOTAL_MISMATCH'] }]);
  });

  it('mixed batch: job FAILED listing ONLY the offending invoice; valid one is not listed; narrowing the period is the way out', async () => {
    const c = await company();
    const [good, bad] = await seed(c, [{ lines: [{ qty: '3', unitPrice: '10.5', lineTotal: '31.50' }] }, { lines: [{ qty: '1', unitPrice: '100', vatRate: '12', lineTotal: '112' }] }]);
    const { saved, putObject } = await run(c, 'XML');
    expect(saved.status).toBe('FAILED');
    expect(putObject).not.toHaveBeenCalled();
    const log = saved.errorLog as Log;
    expect(log.violations.map((v) => v.invoiceId)).toEqual([bad!.id]);
    expect(log.violations.some((v) => v.invoiceId === good!.id)).toBe(false);
  });

  it('valid document exports as before: GENERATED, recordCount, mappingVersion 2, sha256 of the uploaded bytes, Ид = invoice id; repeat export identical', async () => {
    const c = await company();
    const [inv] = await seed(c, [{ lines: [{ qty: '3', unitPrice: '10.5', lineTotal: '31.50' }] }]);
    const a = await run(c, 'CSV');
    const b = await run(c, 'CSV');
    for (const r of [a, b]) {
      expect(r.err).toBeNull();
      expect(r.saved.status).toBe('GENERATED');
      expect(r.saved.mappingVersion).toBe(2);
      expect(r.saved.errorLog).toBeNull();
      const buf = (r.putObject.mock.calls[0]![0] as { buffer: Buffer }).buffer;
      expect(r.saved.fileHash).toBe(createHash('sha256').update(buf).digest('hex'));
      expect(buf.toString('utf8')).toContain(`SALE,${inv!.id},${inv!.number}`);
      expect(buf.toString('utf8')).toContain(',3,10.5,31.5,31.5,');
    }
    expect(a.saved.fileHash).toBe(b.saved.fileHash);
  });

  it('EXCEL (header-only, no line data) is not rejected; generation error path keeps retry/FAILED semantics', async () => {
    const c = await company();
    await seed(c, [{ lines: [{ qty: '1', unitPrice: '100', vatRate: '12', lineTotal: '112' }] }]);
    expect((await run(c, 'EXCEL')).saved.status).toBe('GENERATED');
    const c2 = await company();
    await seed(c2, [{ lines: [{ qty: '1', unitPrice: '100', lineTotal: '100' }] }]);
    const down = vi.fn().mockRejectedValue(new Error('s3 down'));
    expect((await run(c2, 'CSV', down, { made: 0, max: 3 })).saved.status).toBe('QUEUED');
    const last = await run(c2, 'CSV', down, { made: 2, max: 3 });
    expect(last.err?.message).toBe('s3 down');
    expect(last.saved.status).toBe('FAILED');
    expect(last.saved.errorLog).toEqual({ message: 's3 down' });
  });

  it('order-less OPENING invoice (real opening-balance shape: orderId null, no lines, total > 0) is never exported nor falsely rejected as TOTAL_MISMATCH', async () => {
    const c = await company();
    const [good] = await seed(c, [{ lines: [{ qty: '3', unitPrice: '10.5', lineTotal: '31.50' }] }]);
    await tenantPrisma.run(c, async (tx) => {
      const customer = await tx.customer.create({ data: { companyId: c, code: `C-${randomUUID().slice(0, 8)}`, name: 'Opening Cust' } });
      const user = await tx.user.create({ data: { companyId: c, firstName: 'A', lastName: 'B', phone: `+9989${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}` } });
      const batch = await tx.openingBalanceBatch.create({ data: { companyId: c, kind: 'CUSTOMER_BALANCE', asOfDate: new Date(), source: 'test', fileHash: 'h', createdBy: user.id } });
      await tx.invoice.create({ data: { companyId: c, number: `OB-${randomUUID().slice(0, 8)}`, customerId: customer.id, kind: 'OPENING', openingBatchId: batch.id, externalDocRef: 'DOC-1', total: '500000.00', status: InvoiceStatus.OPEN } });
    });
    for (const format of ['XML', 'CSV'] as const) {
      const { err, saved, putObject } = await run(c, format);
      expect(err).toBeNull();
      expect(saved.status).toBe('GENERATED');
      const body = (putObject.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf8');
      expect(body).toContain(good!.number);
      expect(body).not.toContain('OB-');
      expect(body).not.toContain('500000');
    }
  });

  it('tenant isolation: another tenant\'s unsupported invoice does not affect this export; a valid tenant still GENERATED', async () => {
    const bad = await company();
    const good = await company();
    await seed(bad, [{ lines: [{ qty: '1', unitPrice: '100', vatRate: '12', lineTotal: '112' }] }]);
    await seed(good, [{ lines: [{ qty: '1', unitPrice: '100', lineTotal: '100' }] }]);
    expect((await run(good, 'XML')).saved.status).toBe('GENERATED');
    expect((await run(bad, 'XML')).saved.status).toBe('FAILED');
  });
});
