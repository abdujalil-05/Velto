import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { ProductNotFoundException } from '../catalog/catalog-exceptions';
import { StockService } from '../stock/stock.service';
import {
  InvalidPurchaseOrderTransitionException,
  OverReceiptException,
  PurchaseOrderHasReceiptsException,
  PurchaseOrderNotReceivableException,
  ReceiptWarehouseMismatchException,
  SupplierNotFoundException,
} from './purchases-exceptions';
import { computePurchaseLineTotal, PurchasesService } from './purchases.service';

describe('PurchasesService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let otherWarehouseId: string;
  let supplierId: string;
  let productA: string;
  let productB: string;
  let foreignCompanyId: string;
  let foreignSupplierId: string;
  let foreignProductId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const stock = new StockService(tenantPrisma, auditLog);
  const purchases = new PurchasesService(tenantPrisma, auditLog, stock, new DocumentNumberingService());
  const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);

  async function makeTenant(label: string, phone: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-purch-${label}-${Date.now()}`, name: label } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `${label} Co` } });
    const dbUser = await systemPrisma.user.create({
      data: { companyId: company.id, firstName: 'Buyer', lastName: label, phone },
    });
    return { companyId: company.id, userId: dbUser.id };
  }

  async function onHand(productId: string, wid = warehouseId) {
    const level = await run(() =>
      tenantPrisma.client.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId: wid } } }),
    );
    return level?.onHand.toString() ?? '0';
  }

  async function orderedPo(lines: { productId: string; qty: number; unitPrice: number }[]) {
    return run(() =>
      purchases.createPurchaseOrder({ supplierId, warehouseId, status: 'ORDERED', lines }, user),
    );
  }

  beforeAll(async () => {
    const suffix = String(Date.now()).slice(-6);
    const a = await makeTenant('A', `+99891${suffix}1`);
    companyId = a.companyId;
    user = { id: a.userId, companyId, firstName: 'Buyer', lastName: 'A', roles: ['WAREHOUSE'], permissions: [] };

    await tenantPrisma.run(companyId, async (tx) => {
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'Purch WH' } })).id;
      otherWarehouseId = (await tx.warehouse.create({ data: { companyId, name: 'Purch WH 2' } })).id;
      supplierId = (await tx.supplier.create({ data: { companyId, name: 'Acme Supply' } })).id;
      productA = (
        await tx.product.create({ data: { companyId, sku: 'PUR-A', name: 'Purch A', baseUnit: 'dona', vatRate: 12 } })
      ).id;
      productB = (
        await tx.product.create({ data: { companyId, sku: 'PUR-B', name: 'Purch B', baseUnit: 'kg', vatRate: 0 } })
      ).id;
    });

    const b = await makeTenant('B', `+99891${suffix}2`);
    foreignCompanyId = b.companyId;
    await tenantPrisma.run(b.companyId, async (tx) => {
      foreignSupplierId = (await tx.supplier.create({ data: { companyId: b.companyId, name: 'Foreign Supply' } })).id;
      foreignProductId = (
        await tx.product.create({ data: { companyId: b.companyId, sku: 'PUR-X', name: 'Foreign', baseUnit: 'dona' } })
      ).id;
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('computePurchaseLineTotal rounds once per line, HALF_UP to 2 dp', () => {
    expect(computePurchaseLineTotal('3', '1000.00', '12').toFixed(2)).toBe('3360.00');
    // 0.333 × 10.01 × 1.12 = 3.7333296 → 3.73
    expect(computePurchaseLineTotal('0.333', '10.01', '12').toFixed(2)).toBe('3.73');
    // 1 × 0.05 × 1.10 = 0.055 → 0.06 (HALF_UP, not banker's)
    expect(computePurchaseLineTotal('1', '0.05', '10').toFixed(2)).toBe('0.06');
  });

  it('create() computes line totals + totalAmount server-side and snapshots product data', async () => {
    const po = await run(() =>
      purchases.createPurchaseOrder(
        {
          supplierId,
          warehouseId,
          lines: [
            { productId: productA, qty: 3, unitPrice: 1000 },
            { productId: productB, qty: 2.5, unitPrice: 4000.4 },
          ],
        },
        user,
      ),
    );
    expect(po.status).toBe('DRAFT');
    expect(po.number).toMatch(/^PO-\d{4}-\d{6}$/);
    const lineA = po.lines.find((l) => l.productId === productA)!;
    const lineB = po.lines.find((l) => l.productId === productB)!;
    expect(lineA.lineTotal.toFixed(2)).toBe('3360.00'); // 3 × 1000 × 1.12
    expect(lineA.productSku).toBe('PUR-A');
    expect(lineA.unit).toBe('dona');
    expect(lineA.vatRate.toString()).toBe('12');
    expect(lineB.lineTotal.toFixed(2)).toBe('10001.00'); // 2.5 × 4000.40 × 1.00
    expect(po.totalAmount.toFixed(2)).toBe('13361.00');
  });

  it('status transitions: DRAFT→ORDERED ok, ORDERED→ORDERED rejected, DRAFT→CANCELLED ok, CANCELLED→ORDERED rejected', async () => {
    const draft = await run(() =>
      purchases.createPurchaseOrder({ supplierId, warehouseId, lines: [{ productId: productA, qty: 1, unitPrice: 1 }] }, user),
    );
    const ordered = await run(() => purchases.markOrdered(draft.id, user));
    expect(ordered.status).toBe('ORDERED');
    expect(ordered.orderedAt).not.toBeNull();
    await expect(run(() => purchases.markOrdered(draft.id, user))).rejects.toBeInstanceOf(
      InvalidPurchaseOrderTransitionException,
    );

    const draft2 = await run(() =>
      purchases.createPurchaseOrder({ supplierId, warehouseId, lines: [{ productId: productA, qty: 1, unitPrice: 1 }] }, user),
    );
    const cancelled = await run(() => purchases.cancelPurchaseOrder(draft2.id, user));
    expect(cancelled.status).toBe('CANCELLED');
    await expect(run(() => purchases.markOrdered(draft2.id, user))).rejects.toBeInstanceOf(
      InvalidPurchaseOrderTransitionException,
    );
    await expect(run(() => purchases.cancelPurchaseOrder(draft2.id, user))).rejects.toBeInstanceOf(
      InvalidPurchaseOrderTransitionException,
    );

    const audits = await run(() =>
      tenantPrisma.client.auditLog.count({ where: { entityId: draft.id, action: 'purchase_order.status' } }),
    );
    expect(audits).toBe(1);
  });

  it('a DRAFT purchase order cannot be received against', async () => {
    const draft = await run(() =>
      purchases.createPurchaseOrder({ supplierId, warehouseId, lines: [{ productId: productA, qty: 5, unitPrice: 1 }] }, user),
    );
    await expect(
      run(() =>
        purchases.createGoodsReceipt(
          { clientId: randomUUID(), purchaseOrderId: draft.id, lines: [{ purchaseOrderLineId: draft.lines[0]!.id, qty: 1 }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(PurchaseOrderNotReceivableException);
  });

  it('partial then full receipt: one RECEIVE movement per line, onHand and qtyReceived move together, status follows', async () => {
    const before = Number(await onHand(productA));
    const po = await orderedPo([{ productId: productA, qty: 10, unitPrice: 500 }]);
    const lineId = po.lines[0]!.id;

    const r1 = await run(() =>
      purchases.createGoodsReceipt({ clientId: randomUUID(), purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, qty: 4 }] }, user),
    );
    let fresh = await run(() => purchases.getPurchaseOrder(po.id));
    expect(fresh.status).toBe('PARTIALLY_RECEIVED');
    expect(fresh.lines[0]!.qtyReceived.toString()).toBe('4');
    expect(await onHand(productA)).toBe(String(before + 4));
    expect(r1.warehouseId).toBe(warehouseId);
    expect(r1.supplierId).toBe(supplierId);
    expect(r1.lines[0]!.unitCost?.toFixed(2)).toBe('500.00');

    const movements = await run(() =>
      tenantPrisma.client.stockMovement.findMany({ where: { refType: 'GoodsReceipt', refId: r1.id } }),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]!.type).toBe('RECEIVE');
    expect(movements[0]!.qty.toString()).toBe('4');

    await run(() =>
      purchases.createGoodsReceipt({ clientId: randomUUID(), purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, qty: 6 }] }, user),
    );
    fresh = await run(() => purchases.getPurchaseOrder(po.id));
    expect(fresh.status).toBe('RECEIVED');
    expect(fresh.lines[0]!.qtyReceived.toString()).toBe('10');
    expect(await onHand(productA)).toBe(String(before + 10));
    expect(fresh.goodsReceipts).toHaveLength(2);
  });

  it('over-receipt is rejected and nothing is posted', async () => {
    const before = await onHand(productB);
    const po = await orderedPo([{ productId: productB, qty: 5, unitPrice: 100 }]);
    const lineId = po.lines[0]!.id;
    // Two lines on the same PO line are summed before the check (3 + 3 > 5).
    await expect(
      run(() =>
        purchases.createGoodsReceipt(
          {
            clientId: randomUUID(),
            purchaseOrderId: po.id,
            lines: [
              { purchaseOrderLineId: lineId, qty: 3 },
              { purchaseOrderLineId: lineId, qty: 3 },
            ],
          },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(OverReceiptException);
    const fresh = await run(() => purchases.getPurchaseOrder(po.id));
    expect(fresh.lines[0]!.qtyReceived.toString()).toBe('0');
    expect(fresh.goodsReceipts).toHaveLength(0);
    expect(await onHand(productB)).toBe(before);
  });

  it('receipt warehouse must match the PO warehouse', async () => {
    const po = await orderedPo([{ productId: productA, qty: 1, unitPrice: 1 }]);
    await expect(
      run(() =>
        purchases.createGoodsReceipt(
          { clientId: randomUUID(), purchaseOrderId: po.id, warehouseId: otherWarehouseId, lines: [{ purchaseOrderLineId: po.lines[0]!.id, qty: 1 }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(ReceiptWarehouseMismatchException);
  });

  it('cancel is rejected once any quantity has been received', async () => {
    const po = await orderedPo([{ productId: productA, qty: 4, unitPrice: 1 }]);
    await run(() =>
      purchases.createGoodsReceipt({ clientId: randomUUID(), purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0]!.id, qty: 1 }] }, user),
    );
    await expect(run(() => purchases.cancelPurchaseOrder(po.id, user))).rejects.toBeInstanceOf(
      PurchaseOrderHasReceiptsException,
    );
  });

  it('ad-hoc receipt without a PO posts stock with an optional supplier', async () => {
    const before = Number(await onHand(productB, otherWarehouseId));
    const receipt = await run(() =>
      purchases.createGoodsReceipt(
        { clientId: randomUUID(), warehouseId: otherWarehouseId, lines: [{ productId: productB, qty: 1.5, unitCost: 20 }] },
        user,
      ),
    );
    expect(receipt.purchaseOrderId).toBeNull();
    expect(receipt.supplierId).toBeNull();
    expect(await onHand(productB, otherWarehouseId)).toBe(String(before + 1.5));
  });

  it('listGoodsReceipts: filter by PO, ad-hoc included, own tenant only, light summary', async () => {
    const po = await orderedPo([{ productId: productA, qty: 5, unitPrice: 10 }]);
    const poLine = (await run(() => purchases.getPurchaseOrder(po.id))).lines[0]!;
    await run(() =>
      purchases.createGoodsReceipt(
        { clientId: randomUUID(), purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLine.id, qty: 2 }] },
        user,
      ),
    );
    const adhoc = await run(() =>
      purchases.createGoodsReceipt(
        { clientId: randomUUID(), warehouseId: otherWarehouseId, lines: [{ productId: productB, qty: 1.5, unitCost: 20 }] },
        user,
      ),
    );
    const byPo = await run(() => purchases.listGoodsReceipts({ page: 1, pageSize: 25, purchaseOrderId: po.id }));
    expect(byPo.data).toHaveLength(1);
    expect(byPo.data[0]!.totalQty).toBe('2.000');
    expect(byPo.data[0]!.lineCount).toBe(1);
    expect(byPo.data[0]!.purchaseOrder?.id).toBe(po.id);

    const all = await run(() => purchases.listGoodsReceipts({ page: 1, pageSize: 100 }));
    const found = all.data.find((r) => r.id === adhoc.id);
    expect(found?.purchaseOrder).toBeNull();
    expect(found?.totalQty).toBe('1.500');

    const foreign = await tenantPrisma.run(foreignCompanyId, () =>
      purchases.listGoodsReceipts({ page: 1, pageSize: 100 }),
    );
    expect(foreign.data).toHaveLength(0);
  });

  it("another tenant's supplier / product are not visible (RLS) and are rejected", async () => {
    await expect(
      run(() =>
        purchases.createPurchaseOrder(
          { supplierId: foreignSupplierId, warehouseId, lines: [{ productId: productA, qty: 1, unitPrice: 1 }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(SupplierNotFoundException);
    await expect(
      run(() =>
        purchases.createPurchaseOrder(
          { supplierId, warehouseId, lines: [{ productId: foreignProductId, qty: 1, unitPrice: 1 }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(ProductNotFoundException);
    await expect(
      run(() => purchases.createGoodsReceipt({ clientId: randomUUID(), warehouseId, lines: [{ productId: foreignProductId, qty: 1 }] }, user)),
    ).rejects.toBeInstanceOf(ProductNotFoundException);
  });

  it('two concurrent receipts for the last remaining qty: exactly one wins, qtyReceived never exceeds qty', async () => {
    const before = Number(await onHand(productA));
    const po = await orderedPo([{ productId: productA, qty: 10, unitPrice: 1 }]);
    const lineId = po.lines[0]!.id;
    await run(() =>
      purchases.createGoodsReceipt({ clientId: randomUUID(), purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, qty: 7 }] }, user),
    );

    const attempt = () =>
      run(() => purchases.createGoodsReceipt({ clientId: randomUUID(), purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, qty: 3 }] }, user));
    const results = await Promise.allSettled([attempt(), attempt()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    // The loser waits on the PO header lock, then sees either the RECEIVED
    // status or a zero remainder — both are correct refusals.
    expect(
      rejected[0]!.reason instanceof PurchaseOrderNotReceivableException || rejected[0]!.reason instanceof OverReceiptException,
    ).toBe(true);

    const fresh = await run(() => purchases.getPurchaseOrder(po.id));
    expect(fresh.lines[0]!.qtyReceived.toString()).toBe('10');
    expect(fresh.status).toBe('RECEIVED');
    expect(fresh.goodsReceipts).toHaveLength(2);
    expect(await onHand(productA)).toBe(String(before + 10));
  });

  it('same clientId twice: one receipt, one RECEIVE movement, qtyReceived counted once; replay body is ignored', async () => {
    const before = Number(await onHand(productA));
    const po = await orderedPo([{ productId: productA, qty: 10, unitPrice: 1 }]);
    const lineId = po.lines[0]!.id;
    const clientId = randomUUID();

    const first = await run(() =>
      purchases.createGoodsReceipt({ clientId, purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, qty: 4 }] }, user),
    );
    // Materially different replay body — must still return the stored receipt, unchanged.
    const second = await run(() =>
      purchases.createGoodsReceipt({ clientId, purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, qty: 6 }] }, user),
    );
    expect(second.id).toBe(first.id);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]!.qty.toString()).toBe('4');

    const fresh = await run(() => purchases.getPurchaseOrder(po.id));
    expect(fresh.lines[0]!.qtyReceived.toString()).toBe('4');
    expect(fresh.status).toBe('PARTIALLY_RECEIVED');
    expect(fresh.goodsReceipts).toHaveLength(1);
    const movements = await run(() =>
      tenantPrisma.client.stockMovement.findMany({ where: { refType: 'GoodsReceipt', refId: first.id } }),
    );
    expect(movements).toHaveLength(1);
    expect(await onHand(productA)).toBe(String(before + 4));
  });

  it('two parallel requests with the same clientId: exactly one set of effects, both get the same receipt', async () => {
    const beforeA = Number(await onHand(productA));
    const beforeB = Number(await onHand(productB));
    const po = await orderedPo([{ productId: productA, qty: 5, unitPrice: 1 }]);
    const lineId = po.lines[0]!.id;
    const clientId = randomUUID();

    // With a PO (duplicate serialises on the PO lock, then finds the winner).
    const withPo = () =>
      run(() => purchases.createGoodsReceipt({ clientId, purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, qty: 5 }] }, user));
    const [p1, p2] = await Promise.all([withPo(), withPo()]);
    expect(p1.id).toBe(p2.id);
    const fresh = await run(() => purchases.getPurchaseOrder(po.id));
    expect(fresh.lines[0]!.qtyReceived.toString()).toBe('5');
    expect(fresh.status).toBe('RECEIVED');
    expect(fresh.goodsReceipts).toHaveLength(1);
    expect(await onHand(productA)).toBe(String(beforeA + 5));

    // Ad-hoc (no PO lock — the unique index + P2002 recovery is what dedupes).
    const adHocClientId = randomUUID();
    const adHoc = () =>
      run(() => purchases.createGoodsReceipt({ clientId: adHocClientId, warehouseId, lines: [{ productId: productB, qty: 2 }] }, user));
    const [a1, a2] = await Promise.all([adHoc(), adHoc()]);
    expect(a1.id).toBe(a2.id);
    const count = await run(() => tenantPrisma.client.goodsReceipt.count({ where: { clientId: adHocClientId } }));
    expect(count).toBe(1);
    const movements = await run(() =>
      tenantPrisma.client.stockMovement.findMany({ where: { refType: 'GoodsReceipt', refId: a1.id } }),
    );
    expect(movements).toHaveLength(1);
    expect(await onHand(productB)).toBe(String(beforeB + 2));
  });
});
