// Payment, PaymentAllocation, PaymentReversal and StockMovement are append-only,
// so committed fixtures could never be removed and would show up in every later
// audit of this database. The seeded case therefore lives in a transaction that
// is always rolled back; nothing here survives the test.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { systemPrisma, type TenantClient } from '../client';
import { anonymisedSummary, auditCompany, auditDeletedCustomers, enterReadOnly, resolveFindings, runReadOnly } from '../audit-deleted-customers';

const READ_ONLY_REJECTED = /read-only transaction|25006/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

/** Hash of every row the audit reads for this company, updatedAt and changeSeq included. */
async function digest(tx: TenantClient, companyId: string): Promise<string> {
  const [row] = await tx.$queryRaw<{ digest: string }[]>`
    SELECT md5(string_agg(x.r, '|' ORDER BY x.r)) AS digest FROM (
      SELECT row_to_json(t)::text AS r FROM "Customer" t WHERE t."companyId" = ${companyId}::uuid
      UNION ALL SELECT row_to_json(t)::text FROM "SalesOrder" t WHERE t."companyId" = ${companyId}::uuid
      UNION ALL SELECT row_to_json(t)::text FROM "Invoice" t WHERE t."companyId" = ${companyId}::uuid
      UNION ALL SELECT row_to_json(t)::text FROM "Payment" t WHERE t."companyId" = ${companyId}::uuid
      UNION ALL SELECT row_to_json(t)::text FROM "PaymentReversal" t WHERE t."companyId" = ${companyId}::uuid
      UNION ALL SELECT row_to_json(t)::text FROM "StockMovement" t WHERE t."companyId" = ${companyId}::uuid
      UNION ALL SELECT row_to_json(a)::text FROM "PaymentAllocation" a
        JOIN "Payment" p ON p.id = a."paymentId" WHERE p."companyId" = ${companyId}::uuid
      UNION ALL SELECT row_to_json(t)::text FROM "AuditLog" t WHERE t."companyId" = ${companyId}::uuid
    ) x`;
  return row?.digest ?? '';
}

describe('audit-deleted-customers', () => {
  it('finds every seeded case, scopes them to the company, and writes nothing', { timeout: 30_000 }, async () => {
    await inRolledBackTx(async (tx) => {
      const stamp = randomUUID();
      const deletedAt = new Date(Date.now() - 86_400_000);
      const beforeDelete = new Date(deletedAt.getTime() - 86_400_000);

      const tenant = await tx.tenant.create({ data: { slug: `audit-${stamp}`, name: 'Audit Tenant' } });
      const company = await tx.company.create({ data: { tenantId: tenant.id, name: 'Audit Co' } });
      const other = await tx.company.create({ data: { tenantId: tenant.id, name: 'Audit Other Co' } });
      const companyId = company.id;

      const customer = (code: string, gone = true, owner = companyId) =>
        tx.customer.create({ data: { companyId: owner, code, name: 'x', deletedAt: gone ? deletedAt : null } });
      const dirty = await customer('DIRTY');
      const clean = await customer('CLEAN');
      const collided = await customer('COLLIDE');
      const inactiveHolder = await tx.customer.create({
        data: { companyId, code: 'COLLIDE', name: 'x', isActive: false },
      });
      const scoped = await customer('ONLY-OTHER');
      const otherLive = await customer('ONLY-OTHER', false, other.id);
      const otherDeleted = await customer('OTHER-DIRTY', true, other.id);

      const actor = await tx.user.create({
        data: { companyId, firstName: 'a', lastName: 'b', phone: `+998${stamp.slice(0, 8)}` },
      });
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'W' } });
      const otherWarehouse = await tx.warehouse.create({ data: { companyId: other.id, name: 'W' } });
      const product = await tx.product.create({ data: { companyId, sku: 'P', name: 'P', baseUnit: 'dona' } });

      const order = (status: 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CLOSED' | 'CANCELLED') =>
        tx.salesOrder.create({
          data: {
            companyId,
            number: `SO-${status}`,
            customerId: dirty.id,
            warehouseId: warehouse.id,
            status,
            ...(status === 'CANCELLED' ? { cancelReason: 'x', cancelledAt: new Date() } : {}),
          },
        });
      const draft = await order('DRAFT');
      const submitted = await order('SUBMITTED');
      const confirmed = await order('CONFIRMED');
      const shipped = await order('SHIPPED');
      const delivered = await order('DELIVERED');
      const closed = await order('CLOSED');
      const cancelled = await order('CANCELLED');
      await tx.salesOrder.create({
        data: { companyId: other.id, number: 'SO-O', customerId: otherDeleted.id, warehouseId: otherWarehouse.id, status: 'SUBMITTED' },
      });

      const move = (refId: string, type: 'RESERVE' | 'RELEASE' | 'ISSUE', qty: string) =>
        tx.stockMovement.create({
          data: { companyId, productId: product.id, warehouseId: warehouse.id, type, qty, refType: 'SalesOrder', refId },
        });
      // confirmed: 5 - 1 - 2 leaves 2 reserved. shipped: 3 - 3 leaves none.
      await move(confirmed.id, 'RESERVE', '5.000');
      await move(confirmed.id, 'RELEASE', '1.000');
      await move(confirmed.id, 'ISSUE', '2.000');
      await move(shipped.id, 'RESERVE', '3.000');
      await move(shipped.id, 'ISSUE', '3.000');

      const invoice = await tx.invoice.create({
        data: { companyId, number: 'INV-A', customerId: dirty.id, total: '100.00' },
      });
      const payment = (number: string, amount: string, status: 'POSTED' | 'PENDING_HANDOVER' = 'POSTED') =>
        tx.payment.create({
          data: {
            companyId,
            number,
            customerId: dirty.id,
            amount,
            method: 'CASH',
            status,
            collectedBy: status === 'PENDING_HANDOVER' ? actor.id : null,
          },
        });
      const allocated = await payment('PAY-A', '60.00');
      const lateAllocation = await tx.paymentAllocation.create({
        data: { paymentId: allocated.id, invoiceId: invoice.id, amount: '40.00' },
      });
      await tx.paymentAllocation.create({
        data: { paymentId: allocated.id, invoiceId: invoice.id, amount: '20.00', createdAt: beforeDelete },
      });
      await payment('PAY-B', '30.00'); // unallocated: an advance
      const pending = await payment('PAY-C', '5.00', 'PENDING_HANDOVER');
      const reversed = await payment('PAY-D', '7.00');
      const lateReversal = await tx.paymentReversal.create({
        data: { companyId, reversesPaymentId: reversed.id, reason: 'x', actorId: actor.id },
      });
      const oldPayment = await payment('PAY-E', '1.00');
      await tx.paymentReversal.create({
        data: { companyId, reversesPaymentId: oldPayment.id, reason: 'x', actorId: actor.id, createdAt: beforeDelete },
      });
      await tx.customer.update({ where: { id: dirty.id }, data: { cachedBalance: '1.00' } });

      const before = await digest(tx, companyId);
      await enterReadOnly(tx);
      const report = await auditCompany(tx, companyId);

      const refs = (id: string) => [{ customerId: dirty.id, id }];
      expect(report.deletedCustomers).toBe(4);
      expect(report.allocationsAfterDelete).toEqual(refs(lateAllocation.id));
      expect(report.reversalsAfterDelete).toEqual(refs(lateReversal.id));
      expect(report.ordersByStatus).toEqual({
        DRAFT: refs(draft.id),
        SUBMITTED: refs(submitted.id),
        CONFIRMED: refs(confirmed.id),
        SHIPPED: refs(shipped.id),
        DELIVERED: refs(delivered.id),
      });
      const orderIds = Object.values(report.ordersByStatus).flat().map((ref) => ref.id);
      expect(orderIds).not.toContain(closed.id);
      expect(orderIds).not.toContain(cancelled.id);
      expect(report.remainingReservations).toEqual(refs(confirmed.id));
      expect(report.nonZeroBalance).toEqual([dirty.id]);
      expect(report.nonZeroAdvance).toEqual([dirty.id]);
      expect(report.nonZeroCachedBalance).toEqual([dirty.id]);
      expect(report.pendingHandoverPayments).toEqual(refs(pending.id));
      // A live but inactive customer still blocks restore; company B's code does not.
      expect(report.codeReusedByActive).toEqual([{ customerId: collided.id, id: inactiveHolder.id }]);

      const serialized = JSON.stringify(report);
      for (const foreign of [clean.id, scoped.id, otherLive.id, otherDeleted.id]) {
        // `clean` and `scoped` are counted in deletedCustomers but have no finding.
        expect(serialized).not.toContain(foreign);
      }

      expect(resolveFindings(report)).toEqual([
        { ...refs(draft.id)[0], kind: 'ORDER', resolution: 'CANCEL' },
        { ...refs(submitted.id)[0], kind: 'ORDER', resolution: 'CANCEL' },
        { ...refs(confirmed.id)[0], kind: 'ORDER', resolution: 'CANCEL' },
        { ...refs(shipped.id)[0], kind: 'ORDER', resolution: 'DELIVER_THEN_CLOSE' },
        { ...refs(delivered.id)[0], kind: 'ORDER', resolution: 'DELIVER_THEN_CLOSE' },
        { customerId: collided.id, id: inactiveHolder.id, kind: 'CODE_CONFLICT', resolution: 'RESTORE_REQUIRED' },
      ]);

      const summary = anonymisedSummary({ companiesScanned: 2, companies: [report] });
      expect(summary.companies).toEqual([{ company: 'company-1', counts: summary.total }]);
      expect(summary.total).toMatchObject({
        deletedCustomers: 4,
        ordersByStatus: { DRAFT: 1, SUBMITTED: 1, CONFIRMED: 1, SHIPPED: 1, DELIVERED: 1 },
        remainingReservations: 1,
        codeReusedByActive: 1,
        resolutions: { CANCEL: 3, DELIVER_THEN_CLOSE: 2, RESTORE_REQUIRED: 1 },
      });
      const summaryText = JSON.stringify(summary);
      expect(summaryText).not.toMatch(UUID);
      for (const pii of ['DIRTY', 'COLLIDE', 'ONLY-OTHER', 'Audit Co', actor.phone, 'SO-', 'PAY-', 'INV-']) {
        expect(summaryText).not.toContain(pii);
      }

      expect(await digest(tx, companyId)).toBe(before);
      await expect(tx.customer.update({ where: { id: dirty.id }, data: { name: 'y' } })).rejects.toThrow(READ_ONLY_REJECTED);
    });
  });

  it('refuses to run in a transaction that could write', async () => {
    await inRolledBackTx(async (tx) => {
      await expect(auditCompany(tx, randomUUID())).rejects.toThrow(/not read-only/);
    });
  });

  it('runReadOnly rejects writes, and the full audit runs on it', async () => {
    await expect(
      runReadOnly((tx) => tx.$executeRaw`UPDATE "Customer" SET name = name WHERE false`),
    ).rejects.toThrow(READ_ONLY_REJECTED);
    const result = await auditDeletedCustomers();
    expect(result.companiesScanned).toBeGreaterThanOrEqual(result.companies.length);
    expect(JSON.stringify(anonymisedSummary(result))).not.toMatch(UUID);
  }, 120_000);
});
