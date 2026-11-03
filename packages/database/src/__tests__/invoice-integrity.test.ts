// PO decision 2026-11-02 (migration 20261102100000_invoice_sale_order_integrity):
// at most one SALE invoice per SalesOrder; a committed SALE invoice may only
// change status (createdAt = turnover date, total, orderId, ... are immutable)
// for every role; Invoice.orderId/customerId cannot point at another company.
// Runs as the RLS-bound app role (prisma/withTenant) and velto_system.
// Fixtures are left behind (CI uses a throwaway DB), like tenant-isolation.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma, withTenant } from '../client';

const SALE_IMMUTABLE = /a SALE invoice may only change status/;
const CROSS_TENANT = /cross-tenant reference/;

describe('Invoice SALE integrity (one per order, immutable turnover date)', () => {
  let companyAId: string;
  let companyBId: string;
  let custAId: string;
  let custBId: string;
  let whAId: string;
  let userAId: string;
  let seq = 0;
  const stamp = Date.now();
  const inv = () => `INV-IT-${stamp}-${++seq}`;

  const newOrder = (companyId = companyAId) =>
    withTenant(companyId, (tx) =>
      tx.salesOrder.create({
        data: { companyId, number: `SO-IT-${stamp}-${++seq}`, customerId: custAId, warehouseId: whAId },
      }),
    );
  const sale = (orderId: string | null, extra: Record<string, unknown> = {}) =>
    withTenant(companyAId, (tx) =>
      tx.invoice.create({ data: { companyId: companyAId, number: inv(), customerId: custAId, orderId, total: '100.00', ...extra } }),
    );

  beforeAll(async () => {
    const [role] = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-inv-integrity-${stamp}`, name: 'Invoice Integrity Tenant' } });
    const [a, b] = await Promise.all([
      systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Invoice Integrity Co A' } }),
      systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Invoice Integrity Co B' } }),
    ]);
    companyAId = a.id;
    companyBId = b.id;
    custAId = (await withTenant(companyAId, (tx) => tx.customer.create({ data: { companyId: companyAId, code: 'IT-A', name: 'IT A' } }))).id;
    custBId = (await withTenant(companyBId, (tx) => tx.customer.create({ data: { companyId: companyBId, code: 'IT-B', name: 'IT B' } }))).id;
    whAId = (await withTenant(companyAId, (tx) => tx.warehouse.create({ data: { companyId: companyAId, name: 'IT WH A' } }))).id;
    userAId = (
      await withTenant(companyAId, (tx) =>
        tx.user.create({ data: { companyId: companyAId, firstName: 'IT', lastName: 'A', phone: `+998${String(stamp).slice(-9)}` } }),
      )
    ).id;
  });

  it('SALE with orderId NULL stays insertable (multiple fixtures)', async () => {
    await expect(sale(null)).resolves.toBeTruthy();
    await expect(sale(null)).resolves.toBeTruthy();
  });

  it('rejects a second SALE invoice for the same order (23505), even after the first is CANCELLED', async () => {
    const order = await newOrder();
    const first = await sale(order.id);
    await expect(sale(order.id)).rejects.toMatchObject({ code: 'P2002' });
    await withTenant(companyAId, (tx) => tx.invoice.update({ where: { id: first.id }, data: { status: 'CANCELLED' } }));
    await expect(sale(order.id)).rejects.toMatchObject({ code: 'P2002' });
    await expect(systemPrisma.invoice.create({ data: { companyId: companyAId, number: inv(), customerId: custAId, orderId: order.id, total: '1.00' } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('SALE: status UPDATE allowed; createdAt/total/orderId/customerId/number/companyId rejected (velto_app)', async () => {
    const order = await newOrder();
    const other = await newOrder();
    const s = await sale(order.id);
    const upd = (data: Record<string, unknown>) =>
      withTenant(companyAId, (tx) => tx.invoice.update({ where: { id: s.id }, data }));
    await expect(upd({ status: 'PARTIALLY_PAID' })).resolves.toMatchObject({ status: 'PARTIALLY_PAID' });
    await expect(upd({ status: 'PAID' })).resolves.toMatchObject({ status: 'PAID' });
    for (const data of [
      { createdAt: new Date('2020-01-01') },
      { total: '99.00' },
      { orderId: other.id },
      { orderId: null },
      { number: inv() },
      { status: 'OPEN', total: '100.01' },
    ]) {
      await expect(upd(data)).rejects.toThrow(SALE_IMMUTABLE);
    }
    await expect(upd({ companyId: companyBId })).rejects.toThrow();
    const after = await withTenant(companyAId, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: s.id } }));
    expect(after.total.toString()).toBe('100');
    expect(after.createdAt.getTime()).toBe(s.createdAt.getTime());
    expect(after.orderId).toBe(order.id);
  });

  it('SALE immutability also binds velto_system (BYPASSRLS); status still updatable', async () => {
    const s = await sale((await newOrder()).id);
    await expect(systemPrisma.invoice.update({ where: { id: s.id }, data: { createdAt: new Date('2020-01-01') } })).rejects.toThrow(SALE_IMMUTABLE);
    await expect(systemPrisma.invoice.update({ where: { id: s.id }, data: { total: '1.00' } })).rejects.toThrow(SALE_IMMUTABLE);
    await expect(systemPrisma.invoice.update({ where: { id: s.id }, data: { orderId: null } })).rejects.toThrow(SALE_IMMUTABLE);
    await expect(systemPrisma.invoice.update({ where: { id: s.id }, data: { customerId: custBId } })).rejects.toThrow();
    await expect(systemPrisma.invoice.update({ where: { id: s.id }, data: { status: 'CANCELLED' } })).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('order with an invoice cannot be deleted (FK RESTRICT); order without one can', async () => {
    const withInv = await newOrder();
    await sale(withInv.id);
    await expect(systemPrisma.salesOrder.delete({ where: { id: withInv.id } })).rejects.toMatchObject({ code: 'P2003' });
    const bare = await newOrder();
    await expect(withTenant(companyAId, (tx) => tx.salesOrder.delete({ where: { id: bare.id } }))).resolves.toBeTruthy();
  });

  it("another company cannot see or link company A's order/customer on an invoice", async () => {
    const order = await newOrder();
    await sale(order.id);
    expect(await withTenant(companyBId, (tx) => tx.invoice.findMany({ where: { orderId: order.id } }))).toHaveLength(0);
    await expect(
      withTenant(companyBId, (tx) =>
        tx.invoice.create({ data: { companyId: companyBId, number: inv(), customerId: custBId, orderId: order.id, total: '1.00' } }),
      ),
    ).rejects.toThrow(CROSS_TENANT);
    await expect(
      systemPrisma.invoice.create({ data: { companyId: companyBId, number: inv(), customerId: custBId, orderId: order.id, total: '1.00' } }),
    ).rejects.toThrow(CROSS_TENANT);
    await expect(
      systemPrisma.invoice.create({ data: { companyId: companyBId, number: inv(), customerId: custAId, total: '1.00' } }),
    ).rejects.toThrow(CROSS_TENANT);
    // Same per-company uniqueness does not collide across companies: B's own order is independent.
    const orderB = await withTenant(companyBId, async (tx) => {
      const wh = await tx.warehouse.create({ data: { companyId: companyBId, name: 'IT WH B' } });
      return tx.salesOrder.create({ data: { companyId: companyBId, number: `SO-IT-B-${stamp}`, customerId: custBId, warehouseId: wh.id } });
    });
    await expect(
      withTenant(companyBId, (tx) =>
        tx.invoice.create({ data: { companyId: companyBId, number: inv(), customerId: custBId, orderId: orderB.id, total: '1.00' } }),
      ),
    ).resolves.toBeTruthy();
  });

  it('OPENING invoices unaffected: insert + void work, opening guard still rejects total change', async () => {
    const batch = await withTenant(companyAId, (tx) =>
      tx.openingBalanceBatch.create({
        data: { companyId: companyAId, kind: 'CUSTOMER_BALANCE', asOfDate: new Date('2026-10-01'), source: 'ob.xlsx', fileHash: randomUUID(), createdBy: userAId },
      }),
    );
    const mk = () =>
      withTenant(companyAId, (tx) =>
        tx.invoice.create({
          data: { companyId: companyAId, number: `OB-IT-${stamp}-${++seq}`, customerId: custAId, total: '50.00', kind: 'OPENING', openingBatchId: batch.id },
        }),
      );
    const o1 = await mk();
    await mk(); // several OPENING invoices (orderId NULL) for one customer are fine
    await expect(withTenant(companyAId, (tx) => tx.invoice.update({ where: { id: o1.id }, data: { total: '1.00' } })))
      .rejects.toThrow(/an OPENING invoice may only change status/);
    await expect(withTenant(companyAId, (tx) => tx.invoice.update({ where: { id: o1.id }, data: { status: 'CANCELLED' } })))
      .resolves.toMatchObject({ status: 'CANCELLED' });
  });
});
