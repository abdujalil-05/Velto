// Fixtures live in a transaction that is always rolled back; nothing survives the test.
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { systemPrisma, type TenantClient } from '../client';
import { enterReadOnly } from '../audit-deleted-customers';
import { diagnose, parseArgs } from '../diagnostics/export-1c-unsupported';

class Rollback extends Error {}

async function inRolledBackTx(fn: (tx: TenantClient) => Promise<void>): Promise<void> {
  const outcome = await systemPrisma
    .$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 30_000 })
    .catch((err: unknown) => err);
  if (!(outcome instanceof Rollback)) throw outcome;
}

describe('export-1c-unsupported diagnostic', () => {
  it('lists GENERATED XML/CSV jobs with now-unsupported invoices only; skips EXCEL/FAILED/clean; scoped by company; read-only', { timeout: 30_000 }, async () => {
    await inRolledBackTx(async (tx) => {
      const tenant = await tx.tenant.create({ data: { slug: `diag1c-${randomUUID()}`, name: 'T' } });
      const companyId = (await tx.company.create({ data: { tenantId: tenant.id, name: 'C' } })).id;
      const customer = await tx.customer.create({ data: { companyId, code: 'C', name: 'x' } });
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'W' } });
      const product = await tx.product.create({ data: { companyId, sku: 'P', name: 'P', baseUnit: 'dona' } });
      const pk = await tx.productPackaging.create({ data: { productId: product.id, name: 'dona', qtyInBaseUnit: '1' } });
      const mk = async (n: string, disc: string, lineTotal: string) => {
        const order = await tx.salesOrder.create({ data: { companyId, number: `SO-${n}`, customerId: customer.id, warehouseId: warehouse.id } });
        await tx.salesOrderLine.create({ data: { orderId: order.id, productId: product.id, packagingId: pk.id, qty: '2', unitPrice: '100', discountPct: disc, vatRate: '0', lineTotal, deliveredQty: '2' } });
        return tx.invoice.create({ data: { companyId, number: `INV-${n}`, customerId: customer.id, orderId: order.id, total: lineTotal, lines: { create: [{ productId: product.id, qty: '2', unitPrice: '100', vatRate: '0', lineTotal }] } } });
      };
      const bad = await mk('BAD', '10', '180.00');
      await mk('OK', '0', '200.00');
      const job = async (format: 'XML' | 'EXCEL', status: 'GENERATED' | 'FAILED') => {
        const j = await tx.exportJob.create({ data: { companyId, type: '1c', format, periodFrom: new Date(Date.now() - 86_400_000), periodTo: new Date(Date.now() + 86_400_000) } });
        await tx.exportJob.update({ where: { id: j.id }, data: { status: 'PROCESSING', attemptCount: 1 } });
        return tx.exportJob.update({
          where: { id: j.id },
          data: status === 'FAILED' ? { status, errorLog: { message: 'x' } } : { status, storageKey: `k/${j.id}`, fileName: 'f', fileSize: 1, fileHash: createHash('sha256').update(j.id).digest('hex'), recordCount: 1, mappingVersion: 2, generatedAt: new Date() },
        });
      };
      const xml = await job('XML', 'GENERATED');
      await job('EXCEL', 'GENERATED');
      await job('XML', 'FAILED');

      await expect(diagnose(tx, companyId)).rejects.toThrow(/not read-only/);
      await enterReadOnly(tx);
      const r = await diagnose(tx, companyId);
      expect(r.jobsNeedingAccountantRecheck).toBe(1);
      expect(r.jobs[0]).toMatchObject({ companyId, exportJobId: xml.id, status: 'GENERATED', format: 'XML', offendingInvoices: 1, invoices: [{ invoiceId: bad.id, invoiceNumber: 'INV-BAD', reasons: ['DISCOUNT', 'QTY_X_PRICE_MISMATCH'] }] });
      await expect(tx.exportJob.updateMany({ data: { errorLog: { message: 'w' } } })).rejects.toThrow(/read-only transaction|25006/i);
    });
  });

  it('parseArgs validates --company', () => {
    expect(parseArgs([])).toEqual({});
    expect(() => parseArgs(['--company', 'nope'])).toThrow(/UUID/);
  });
});
