// Fixtures live in a transaction that is always rolled back; nothing survives the test.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { systemPrisma, type TenantClient } from '../client';
import { enterReadOnly, runReadOnly } from '../audit-deleted-customers';
import { diagnose, diagnoseCompany, parseArgs } from '../diagnostics/adr059-diagnostics';

const READ_ONLY_REJECTED = /read-only transaction|25006/i;

class Rollback extends Error {}

async function inRolledBackTx(fn: (tx: TenantClient) => Promise<void>): Promise<void> {
  const outcome = await systemPrisma
    .$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30_000 },
    )
    .catch((err: unknown) => err);
  if (!(outcome instanceof Rollback)) throw outcome;
}

async function seedCompany(tx: TenantClient, tenantId: string, defaultVatRate: string) {
  const company = await tx.company.create({ data: { tenantId, name: 'Diag Co', defaultVatRate } });
  const companyId = company.id;
  const customer = await tx.customer.create({ data: { companyId, code: 'C', name: 'x' } });
  const warehouse = await tx.warehouse.create({ data: { companyId, name: 'W' } });
  const product = await tx.product.create({
    data: { companyId, sku: 'P', name: 'P', baseUnit: 'dona', vatRate: '12', minPrice: '100.00' },
  });
  const packaging = await tx.productPackaging.create({
    data: { productId: product.id, name: 'quti', qtyInBaseUnit: '16.000' },
  });
  const priceList = await tx.priceList.create({ data: { companyId, name: 'PL' } });
  await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: product.id, price: '90.00' } });

  const order = await tx.salesOrder.create({
    data: { companyId, number: 'SO-DIAG', customerId: customer.id, warehouseId: warehouse.id },
  });
  const line = (qty: string, lineTotal: string) =>
    tx.salesOrderLine.create({
      data: { orderId: order.id, productId: product.id, packagingId: packaging.id, qty, unitPrice: '1000.00', vatRate: '12', lineTotal },
    });
  // 0.1875 box-share stored as 0.188: 0.188 × 1000 × 1.12 = 210.56, stored 210.00.
  const divergent = await line('0.188', '210.00');
  const consistent = await line('1.000', '1120.00');

  const invoice = await tx.invoice.create({
    data: { companyId, number: 'INV-DIAG', customerId: customer.id, orderId: order.id, total: '1330.00' },
  });
  const invLine = (qty: string, lineTotal: string) =>
    tx.invoiceLine.create({
      data: { invoiceId: invoice.id, productId: product.id, qty, unitPrice: '1000.00', vatRate: '12', lineTotal },
    });
  const invDivergent = await invLine('0.188', '210.00');
  const invConsistent = await invLine('1.000', '1120.00');

  // Order-less invoice line, net of VAT (shape of committed test fixtures): reported apart, never as a mismatch.
  const orphan = await tx.invoice.create({
    data: {
      companyId, number: 'INV-ORPHAN', customerId: customer.id, total: '150000.00',
      lines: { create: [{ productId: product.id, qty: '10', unitPrice: '15000', vatRate: '12', lineTotal: '150000' }] },
    },
    include: { lines: true },
  });
  const orphanLine = orphan.lines[0]!;

  return { companyId, product, divergent, consistent, invDivergent, invConsistent, orphanLine };
}

describe('adr059-diagnostics', () => {
  it('detects divergent lines only, scopes by company, and cannot write', { timeout: 30_000 }, async () => {
    await inRolledBackTx(async (tx) => {
      const tenant = await tx.tenant.create({ data: { slug: `diag-${randomUUID()}`, name: 'Diag Tenant' } });
      const a = await seedCompany(tx, tenant.id, '15');
      const b = await seedCompany(tx, tenant.id, '12');

      // Refuses to run on a writable transaction.
      await expect(diagnoseCompany(tx, a.companyId)).rejects.toThrow(/not read-only/);

      await enterReadOnly(tx);
      const scoped = await diagnose(tx, a.companyId);
      expect(scoped.scope).toBe('company');
      expect(scoped.companiesScanned).toBe(1);
      expect(scoped.packagingQtyCheck.checked).toBe(false);
      const [ra] = scoped.companies;
      expect(ra).toMatchObject({
        companyId: a.companyId,
        salesOrderLineMismatch: { count: 1, sampleIds: [a.divergent.id] },
        invoiceLineMismatch: { count: 1, sampleIds: [a.invDivergent.id] },
        invoiceLineDiscountUnknown: { count: 0, sampleIds: [] },
        invoiceLineWithoutOrder: { count: 1, sampleIds: [a.orphanLine.id] },
        productsBelowMinPrice: { count: 1, sampleIds: [a.product.id] },
        defaultVatRate: '15.00',
        defaultVatIsStandard: false,
        productsVatDiffersFromDefault: { count: 1, sampleIds: [a.product.id] },
      });

      const text = JSON.stringify(scoped);
      for (const foreign of [a.consistent.id, a.invConsistent.id, b.companyId, b.divergent.id, b.invDivergent.id, b.product.id]) {
        expect(text).not.toContain(foreign);
      }
      for (const pii of ['Diag Co', 'SO-DIAG', 'INV-DIAG', 'INV-ORPHAN', '"P"']) expect(text).not.toContain(pii);

      const all = await diagnose(tx);
      const rb = all.companies.find((c) => c.companyId === b.companyId);
      expect(rb).toMatchObject({
        salesOrderLineMismatch: { count: 1, sampleIds: [b.divergent.id] },
        defaultVatIsStandard: true,
        productsVatDiffersFromDefault: { count: 0, sampleIds: [] },
      });

      // Last: a failed statement aborts the transaction.
      await expect(
        tx.$executeRaw`UPDATE "SalesOrderLine" SET "lineTotal" = 210.56 WHERE id = ${a.divergent.id}::uuid`,
      ).rejects.toThrow(READ_ONLY_REJECTED);
    });
  });

  it('runs in a read-only transaction for the CLI', async () => {
    await expect(
      runReadOnly((tx) => tx.$executeRaw`UPDATE "Company" SET name = name WHERE false`),
    ).rejects.toThrow(READ_ONLY_REJECTED);
    const result = await runReadOnly((tx) => diagnose(tx, randomUUID()));
    expect(result).toMatchObject({ scope: 'company', companiesScanned: 0, companies: [] });
  });

  it('validates --company', () => {
    expect(parseArgs([])).toEqual({});
    const id = randomUUID();
    expect(parseArgs(['--company', id])).toEqual({ companyId: id });
    expect(() => parseArgs(['--company', 'x'])).toThrow(/UUID/);
  });
});
