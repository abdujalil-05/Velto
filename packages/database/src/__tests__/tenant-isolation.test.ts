// SEC-001..005 / VELTO-TZ.md 6.10: "Har bir yangi jadval uchun izolyatsiya
// testi majburiy" — cross-tenant leak tests must run in CI and block merge.
// This exercises both isolation strategies used in the RLS migration:
// direct-companyId tables (Customer) and parent-subquery child tables
// (RolePermission, isolated via its Role's companyId), plus the fail-closed
// default and the AuditLog append-only trigger.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma, withTenant } from '../client';

// The runtime roles hold no TRUNCATE privilege (TRUNCATE ignores RLS — see
// scripts/provision-roles.sql), so the grant layer rejects it before the
// append-only statement trigger would. Either rejection is acceptable.
const TRUNCATE_REJECTED = /append-only|permission denied/i;

describe('tenant isolation (RLS)', () => {
  // TZ 10.4 / 16.3: a superuser or BYPASSRLS role skips RLS even with FORCE,
  // which would make every case below pass/fail for the wrong reason.
  it('runs as an RLS-bound app role (not superuser, not BYPASSRLS)', async () => {
    const [role] = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  let tenantId: string;
  let otherTenantId: string;
  let companyAId: string;
  let companyBId: string;
  let companyCId: string;
  let permissionId: string;
  let recipientId: string;
  let customerAId: string;
  let customerBId: string;
  let outletAId: string;
  let outletBId: string;
  let warehouseAId: string;
  let warehouseBId: string;
  let productAId: string;
  let productBId: string;
  let priceListAId: string;
  let routeAId: string;
  let courierAId: string;
  let userBId: string;
  let deliveryOrderAId: string;
  let deliveryRouteAId: string;
  let supplierAId: string;
  let supplierBId: string;
  let purchaseOrderAId: string;
  let purchaseOrderLineAId: string;
  let goodsReceiptAId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-isolation-${stamp}`, name: 'Isolation Test Tenant' },
    });
    tenantId = tenant.id;

    // A *second* tenant is required to test the Tenant table's own RLS policy:
    // companies A and B share one tenant, so they alone can't prove that a
    // tenant row from another tenant is invisible.
    const otherTenant = await systemPrisma.tenant.create({
      data: { slug: `test-isolation-other-${stamp}`, name: 'Isolation Test Tenant 2' },
    });
    otherTenantId = otherTenant.id;

    const [companyA, companyB, companyC] = await Promise.all([
      systemPrisma.company.create({ data: { tenantId, name: 'Isolation Test Co A' } }),
      systemPrisma.company.create({ data: { tenantId, name: 'Isolation Test Co B' } }),
      systemPrisma.company.create({ data: { tenantId: otherTenantId, name: 'Isolation Test Co C' } }),
    ]);
    companyAId = companyA.id;
    companyBId = companyB.id;
    companyCId = companyC.id;

    const permission = await systemPrisma.permission.upsert({
      where: { module_code: { module: 'test', code: 'isolation' } },
      update: {},
      create: { module: 'test', code: 'isolation' },
    });
    permissionId = permission.id;

    const customerA = await withTenant(companyAId, (tx) =>
      tx.customer.create({ data: { companyId: companyAId, code: 'A-1', name: 'Customer A' } }),
    );
    customerAId = customerA.id;
    const customerB = await withTenant(companyBId, (tx) =>
      tx.customer.create({ data: { companyId: companyBId, code: 'B-1', name: 'Customer B' } }),
    );
    customerBId = customerB.id;

    // Fixtures for the cross-tenant FK guard triggers
    // (20260808120000_tenant_scoped_keys_and_fk_guards): one of every parent
    // a guarded FK points at, in both company A and company B.
    const [outletA, outletB, warehouseA, warehouseB, productA, productB, priceListA] = await Promise.all([
      withTenant(companyAId, (tx) => tx.outlet.create({ data: { companyId: companyAId, customerId: customerAId, name: 'Outlet A' } })),
      withTenant(companyBId, (tx) => tx.outlet.create({ data: { companyId: companyBId, customerId: customerBId, name: 'Outlet B' } })),
      withTenant(companyAId, (tx) => tx.warehouse.create({ data: { companyId: companyAId, name: 'Warehouse A' } })),
      withTenant(companyBId, (tx) => tx.warehouse.create({ data: { companyId: companyBId, name: 'Warehouse B' } })),
      withTenant(companyAId, (tx) => tx.product.create({ data: { companyId: companyAId, sku: 'ISO-A', name: 'Product A', baseUnit: 'dona' } })),
      withTenant(companyBId, (tx) => tx.product.create({ data: { companyId: companyBId, sku: 'ISO-B', name: 'Product B', baseUnit: 'dona' } })),
      withTenant(companyAId, (tx) => tx.priceList.create({ data: { companyId: companyAId, name: 'Price List A' } })),
    ]);
    outletAId = outletA.id;
    outletBId = outletB.id;
    warehouseAId = warehouseA.id;
    warehouseBId = warehouseB.id;
    productAId = productA.id;
    productBId = productB.id;
    priceListAId = priceListA.id;

    const period = { periodFrom: new Date(), periodTo: new Date() };
    await withTenant(companyAId, (tx) =>
      tx.exportJob.create({ data: { companyId: companyAId, type: '1c', format: 'XML', ...period } }),
    );

    await withTenant(companyAId, (tx) =>
      tx.documentCounter.create({ data: { companyId: companyAId, docType: 'SO', year: 2026, lastNumber: 1 } }),
    );

    const recipient = await systemPrisma.user.create({
      data: { companyId: companyAId, firstName: 'Notify', lastName: 'Me', phone: '+998900000097' },
    });
    recipientId = recipient.id;
    await withTenant(companyAId, (tx) =>
      tx.idempotencyRecord.create({
        data: {
          companyId: companyAId,
          key: 'iso-key-1',
          userId: recipientId,
          route: 'POST /orders',
          requestHash: 'h',
          responseStatus: 201,
          responseBody: {},
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    await withTenant(companyAId, (tx) =>
      tx.notification.create({
        data: {
          companyId: companyAId,
          recipientId,
          type: 'order.on_hold',
          title: { uz: 'Test', ru: 'Test', en: 'Test' },
          message: { uz: 'Test', ru: 'Test', en: 'Test' },
        },
      }),
    );

    // RouteRun (20260806090000_simplify_credit_inn_gps_route_finish) shipped
    // with an RLS policy but no isolation case — added here per 6.10.
    await withTenant(companyAId, async (tx) => {
      const route = await tx.route.create({
        data: { companyId: companyAId, agentId: recipientId, weekday: 1, name: 'Isolation Test Route' },
      });
      routeAId = route.id;
      await tx.routeRun.create({ data: { companyId: companyAId, routeId: route.id, date: new Date('2026-08-08') } });
    });

    // Courier fixtures (20260810170000_couriers_replace_suppliers). A kuryer is
    // an ordinary User carrying the COURIER role, so the cross-tenant guard on
    // "SalesOrder"."courierId" / "Route"."courierId" points at "User".
    const courierA = await systemPrisma.user.create({
      data: { companyId: companyAId, firstName: 'Kuryer', lastName: 'A', phone: '+998900000090' },
    });
    courierAId = courierA.id;
    const userB = await systemPrisma.user.create({
      data: { companyId: companyBId, firstName: 'User', lastName: 'B', phone: '+998900000096' },
    });
    userBId = userB.id;

    // Courier-served outbound work, company A only, on purpose: the Route case
    // above asserts company B owns no route at all, and what needs proving here
    // is that B cannot reach A's — a mirrored B fixture would weaken those
    // assertions without adding coverage. `routeAId` stays agent-served so both
    // arms of the XOR are represented in the fixture set.
    const deliveryRouteA = await withTenant(companyAId, (tx) =>
      tx.route.create({
        data: { companyId: companyAId, courierId: courierAId, weekday: 5, name: 'Courier-served Route A' },
      }),
    );
    deliveryRouteAId = deliveryRouteA.id;
    const deliveryOrderA = await withTenant(companyAId, (tx) =>
      tx.salesOrder.create({
        data: {
          companyId: companyAId,
          number: 'ISO-COU-A',
          customerId: customerAId,
          outletId: outletAId,
          warehouseId: warehouseAId,
          courierId: courierAId,
        },
      }),
    );
    deliveryOrderAId = deliveryOrderA.id;

    // M08 Purchasing (20261012120000_restore_purchasing, ADR-011): one full
    // Supplier -> PurchaseOrder -> line -> GoodsReceipt -> line chain in
    // company A, plus a company-B supplier as a cross-tenant FK target.
    const supplierB = await withTenant(companyBId, (tx) =>
      tx.supplier.create({ data: { companyId: companyBId, name: 'Supplier B' } }),
    );
    supplierBId = supplierB.id;
    await withTenant(companyAId, async (tx) => {
      const supplier = await tx.supplier.create({ data: { companyId: companyAId, name: 'Supplier A' } });
      supplierAId = supplier.id;
      const po = await tx.purchaseOrder.create({
        data: {
          companyId: companyAId,
          number: 'PO-ISO-A',
          supplierId: supplierAId,
          warehouseId: warehouseAId,
          createdById: recipientId,
        },
      });
      purchaseOrderAId = po.id;
      const poLine = await tx.purchaseOrderLine.create({
        data: {
          companyId: companyAId,
          purchaseOrderId: po.id,
          productId: productAId,
          productName: 'Product A',
          productSku: 'ISO-A',
          unit: 'dona',
          qty: 10,
          unitPrice: 1000,
          lineTotal: 10000,
        },
      });
      purchaseOrderLineAId = poLine.id;
      const receipt = await tx.goodsReceipt.create({
        data: {
          companyId: companyAId,
          warehouseId: warehouseAId,
          purchaseOrderId: po.id,
          supplierId: supplierAId,
          clientId: randomUUID(),
        },
      });
      goodsReceiptAId = receipt.id;
      await tx.goodsReceiptLine.create({
        data: {
          companyId: companyAId,
          goodsReceiptId: receipt.id,
          purchaseOrderLineId: poLine.id,
          productId: productAId,
          productName: 'Product A',
          productSku: 'ISO-A',
          unit: 'dona',
          qty: 4,
        },
      });
    });

    await withTenant(companyAId, async (tx) => {
      const role = await tx.role.create({ data: { companyId: companyAId, code: 'ISO_TEST', name: 'Isolation Test Role' } });
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
    });
  });

  afterAll(async () => {
    // F2.5: reconciliation rows RESTRICT-reference users/products/warehouses/
    // customers, so they go first.
    await systemPrisma.reconciliationFinding.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.reconciliationRun.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    // Company/Tenant are deliberately NOT deleted here: the AuditLog test
    // below creates a row that FK-restricts deletion of its Company, and the
    // log itself can never be deleted (append-only). That's the correct
    // behavior for immutable audit history (15.6, ≥3 year retention), so this
    // suite leaves a small, harmless test fixture behind rather than fighting
    // the constraint. CI runs against a throwaway database per run anyway.
    await systemPrisma.rolePermission.deleteMany({ where: { permissionId } });
    await systemPrisma.role.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    // F5.3: ExportJob rows are undeletable (DB trigger, export evidence) and
    // left behind like the AuditLog row.
    await systemPrisma.documentCounter.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.notification.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.idempotencyRecord.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.routeRun.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.routeStop.deleteMany({ where: { routeId: routeAId } });
    await systemPrisma.route.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    const scopedCompanies = { companyId: { in: [companyAId, companyBId, companyCId] } };
    // Orders before users: "SalesOrder"."courierId" is ON DELETE SET NULL, but
    // deleting the rows outright keeps the fixture cleanup exact.
    await systemPrisma.salesOrderLine.deleteMany({ where: { order: scopedCompanies } });
    await systemPrisma.productPackaging.deleteMany({ where: { product: scopedCompanies } });
    await systemPrisma.salesOrder.deleteMany({ where: scopedCompanies });
    // GoodsReceipt/GoodsReceiptLine are append-only (DB triggers, even for
    // velto_system) and their FKs are RESTRICT, so — like the AuditLog row —
    // company A's receipt chain (receipt, its PO/line/supplier, warehouse A,
    // product A) is left behind; only unreferenced rows are deleted.
    await systemPrisma.purchaseOrderLine.deleteMany({ where: { ...scopedCompanies, receiptLines: { none: {} } } });
    await systemPrisma.purchaseOrder.deleteMany({
      where: { ...scopedCompanies, goodsReceipts: { none: {} }, lines: { none: {} } },
    });
    await systemPrisma.supplier.deleteMany({
      where: { ...scopedCompanies, purchaseOrders: { none: {} }, goodsReceipts: { none: {} } },
    });
    await systemPrisma.user.delete({ where: { id: recipientId } });
    await systemPrisma.user.delete({ where: { id: courierAId } });
    await systemPrisma.user.delete({ where: { id: userBId } });
    await systemPrisma.priceListItem.deleteMany({ where: { priceListId: priceListAId } });
    await systemPrisma.stockLevel.deleteMany({ where: { warehouseId: { in: [warehouseAId, warehouseBId] } } });
    await systemPrisma.productCategory.deleteMany({ where: scopedCompanies });
    await systemPrisma.product.deleteMany({
      where: {
        ...scopedCompanies,
        goodsReceiptLines: { none: {} },
        purchaseOrderLines: { none: {} },
        stockMovements: { none: {} },
      },
    });
    await systemPrisma.warehouse.deleteMany({
      where: { ...scopedCompanies, goodsReceipts: { none: {} }, purchaseOrders: { none: {} }, stockMovements: { none: {} } },
    });
    await systemPrisma.outlet.deleteMany({ where: scopedCompanies });
    await systemPrisma.customer.updateMany({ where: scopedCompanies, data: { priceListId: null } });
    await systemPrisma.priceList.deleteMany({ where: scopedCompanies });
    // F2.1: Payment/PaymentAllocation/StockMovement/PaymentReversal are
    // append-only (DB triggers) with RESTRICT FKs — the reversal fixture's
    // customer/invoice/actor chain is left behind like the AuditLog row.
    await systemPrisma.customer.deleteMany({
      where: { ...scopedCompanies, payments: { none: {} }, invoices: { none: {} } },
    });
    await systemPrisma.permission.deleteMany({ where: { id: permissionId } });
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('a direct-companyId table (Customer) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.customer.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.customer.findMany());

    expect(seenFromA.map((c) => c.code)).toEqual(['A-1']);
    expect(seenFromB.map((c) => c.code)).toEqual(['B-1']);
  });

  it('a direct-companyId table (ExportJob, M12 1C export) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.exportJob.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.exportJob.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a direct-companyId table (Notification, M14) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.notification.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.notification.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a direct-companyId table (DocumentCounter, 11.2 document numbering) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.documentCounter.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.documentCounter.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a direct-companyId table (IdempotencyRecord, F1.3) is scoped per tenant and rejects a cross-tenant userId', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.idempotencyRecord.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.idempotencyRecord.findMany());

    expect(seenFromA.map((r) => r.key)).toEqual(['iso-key-1']);
    expect(seenFromB).toHaveLength(0);
    // Outside withTenant: zero rows or the '' ::uuid cast error — both fail
    // closed (see the 'fails closed' case below).
    try {
      expect(await prisma.idempotencyRecord.findMany()).toHaveLength(0);
    } catch (err) {
      expect(String(err)).toMatch(/uuid/i);
    }

    // FK guard trigger: company B cannot store company A's user.
    await expect(
      withTenant(companyBId, (tx) =>
        tx.idempotencyRecord.create({
          data: {
            companyId: companyBId,
            key: 'iso-key-1',
            userId: recipientId, // company A's user
            route: 'POST /orders',
            requestHash: 'h',
            responseStatus: 201,
            responseBody: {},
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a direct-companyId table (RouteRun, 9.4 route finish) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.routeRun.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.routeRun.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a direct-companyId table (Route, 6.8 field) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.route.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.route.findMany());

    // Both arms of the agent-XOR-courier split are company A's; company B must
    // see neither.
    expect(new Set(seenFromA.map((r) => r.id))).toEqual(new Set([routeAId, deliveryRouteAId]));
    expect(seenFromB).toHaveLength(0);
  });

  it('M08 purchasing tables (Supplier/PurchaseOrder/PurchaseOrderLine/GoodsReceipt/GoodsReceiptLine) are scoped per tenant', async () => {
    const read = (companyId: string) =>
      withTenant(companyId, async (tx) => ({
        suppliers: await tx.supplier.findMany(),
        orders: await tx.purchaseOrder.findMany(),
        orderLines: await tx.purchaseOrderLine.findMany(),
        receipts: await tx.goodsReceipt.findMany(),
        receiptLines: await tx.goodsReceiptLine.findMany(),
      }));
    const fromA = await read(companyAId);
    const fromB = await read(companyBId);

    expect(fromA.suppliers.map((s) => s.id)).toEqual([supplierAId]);
    expect(fromA.orders.map((o) => o.id)).toEqual([purchaseOrderAId]);
    expect(fromA.orderLines.map((l) => l.id)).toEqual([purchaseOrderLineAId]);
    expect(fromA.receipts.map((r) => r.id)).toEqual([goodsReceiptAId]);
    expect(fromA.receiptLines).toHaveLength(1);

    expect(fromB.suppliers.map((s) => s.id)).toEqual([supplierBId]);
    expect(fromB.orders).toHaveLength(0);
    expect(fromB.orderLines).toHaveLength(0);
    expect(fromB.receipts).toHaveLength(0);
    expect(fromB.receiptLines).toHaveLength(0);

    // Writes aimed at A's purchasing rows from B match nothing.
    const updated = await withTenant(companyBId, (tx) =>
      tx.purchaseOrder.updateMany({ where: { id: purchaseOrderAId }, data: { note: 'Hijacked' } }),
    );
    expect(updated.count).toBe(0);
  });

  it('rejects purchasing rows that reference another tenant’s supplier/warehouse/product/PO', async () => {
    await expect(
      systemPrisma.purchaseOrder.create({
        data: { companyId: companyAId, number: 'PO-ISO-XT-1', supplierId: supplierBId, warehouseId: warehouseAId },
      }),
    ).rejects.toThrow(/cross-tenant/i);
    await expect(
      systemPrisma.purchaseOrder.create({
        data: { companyId: companyAId, number: 'PO-ISO-XT-2', supplierId: supplierAId, warehouseId: warehouseBId },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    const line = { productName: 'X', productSku: 'X', unit: 'dona', qty: 1, unitPrice: 1, lineTotal: 1 };
    await expect(
      systemPrisma.purchaseOrderLine.create({
        data: { ...line, companyId: companyAId, purchaseOrderId: purchaseOrderAId, productId: productBId },
      }),
    ).rejects.toThrow(/cross-tenant/i);
    // A company-B line smuggled onto company A's PO.
    await expect(
      systemPrisma.purchaseOrderLine.create({
        data: { ...line, companyId: companyBId, purchaseOrderId: purchaseOrderAId, productId: productBId },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    await expect(
      systemPrisma.goodsReceipt.create({
        data: {
          companyId: companyBId,
          warehouseId: warehouseBId,
          purchaseOrderId: purchaseOrderAId,
          clientId: randomUUID(),
        },
      }),
    ).rejects.toThrow(/cross-tenant/i);
    await expect(
      systemPrisma.goodsReceiptLine.create({
        data: {
          companyId: companyAId,
          goodsReceiptId: goodsReceiptAId,
          productId: productBId,
          productName: 'X',
          productSku: 'X',
          unit: 'dona',
          qty: 1,
        },
      }),
    ).rejects.toThrow(/cross-tenant/i);
  });

  it('GoodsReceipt/GoodsReceiptLine are append-only — UPDATE/DELETE/TRUNCATE rejected, even for velto_system', async () => {
    // Owning tenant through the app role.
    await expect(
      withTenant(companyAId, (tx) =>
        tx.$executeRaw`UPDATE "GoodsReceipt" SET note = 'changed' WHERE id = ${goodsReceiptAId}::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      withTenant(companyAId, (tx) => tx.$executeRaw`DELETE FROM "GoodsReceipt" WHERE id = ${goodsReceiptAId}::uuid`),
    ).rejects.toThrow(/append-only/i);
    await expect(
      withTenant(companyAId, (tx) =>
        tx.$executeRaw`UPDATE "GoodsReceiptLine" SET qty = 5 WHERE "goodsReceiptId" = ${goodsReceiptAId}::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      withTenant(companyAId, (tx) =>
        tx.$executeRaw`DELETE FROM "GoodsReceiptLine" WHERE "goodsReceiptId" = ${goodsReceiptAId}::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      withTenant(companyAId, (tx) => tx.$executeRawUnsafe('TRUNCATE TABLE "GoodsReceiptLine"')),
    ).rejects.toThrow(TRUNCATE_REJECTED);

    // BYPASSRLS does not skip triggers: velto_system is blocked too.
    await expect(
      systemPrisma.goodsReceipt.update({ where: { id: goodsReceiptAId }, data: { note: 'changed' } }),
    ).rejects.toThrow(/append-only/i);
    await expect(
      systemPrisma.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: goodsReceiptAId } }),
    ).rejects.toThrow(/append-only/i);
    await expect(systemPrisma.$executeRawUnsafe('TRUNCATE TABLE "GoodsReceipt" CASCADE')).rejects.toThrow(
      TRUNCATE_REJECTED,
    );

    // A receipt's referenced PO line can no longer be removed out from under
    // it (RESTRICT, not a SET NULL cascade that would rewrite history).
    await expect(
      systemPrisma.purchaseOrderLine.delete({ where: { id: purchaseOrderLineAId } }),
    ).rejects.toThrow();

    // History intact.
    const after = await withTenant(companyAId, (tx) =>
      tx.goodsReceipt.findUnique({ where: { id: goodsReceiptAId }, include: { lines: true } }),
    );
    expect(after?.note).toBeNull();
    expect(after?.lines).toHaveLength(1);
    expect(after?.lines[0]?.qty.toString()).toBe('4');
  });

  // 20260808120000_tenant_scoped_keys_and_fk_guards: Tenant was the last table
  // in the schema with no RLS at all. Its policy resolves the tenant through
  // the current company, so a request scoped to company A sees exactly one
  // tenant row and never another tenant's.
  it('Tenant is scoped to the current company’s own tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.tenant.findMany());
    const seenFromC = await withTenant(companyCId, (tx) => tx.tenant.findMany());

    expect(seenFromA.map((t) => t.id)).toEqual([tenantId]);
    expect(seenFromC.map((t) => t.id)).toEqual([otherTenantId]);

    // Explicitly asking for the other tenant by id still returns nothing.
    const probed = await withTenant(companyAId, (tx) => tx.tenant.findUnique({ where: { id: otherTenantId } }));
    expect(probed).toBeNull();
  });

  it('cannot UPDATE another tenant’s Tenant row', async () => {
    const updated = await withTenant(companyAId, (tx) =>
      tx.tenant.updateMany({ where: { id: otherTenantId }, data: { name: 'Hijacked Tenant' } }),
    );
    expect(updated.count).toBe(0);

    const stillThere = await systemPrisma.tenant.findUnique({ where: { id: otherTenantId } });
    expect(stillThere?.name).toBe('Isolation Test Tenant 2');
  });

  // A plain FK only proves the target id exists — not that it belongs to the
  // same company. These cases cover the BEFORE-INSERT guards added in
  // 20260808120000, including via `systemPrisma`, which is BYPASSRLS and would
  // otherwise be able to stitch two tenants' rows together.
  it('SalesOrderLine (parent-subquery policy) is scoped per tenant; deliveredQty defaults to 0 and stays within 0..qty (F2.4)', async () => {
    const line = await withTenant(companyAId, async (tx) => {
      const packaging = await tx.productPackaging.create({
        data: { productId: productAId, name: 'dona', qtyInBaseUnit: '1', isDefault: true },
      });
      return tx.salesOrderLine.create({
        data: {
          orderId: deliveryOrderAId,
          productId: productAId,
          packagingId: packaging.id,
          qty: '5',
          unitPrice: '1000',
          vatRate: '12',
          lineTotal: '5000',
        },
      });
    });
    expect(line.deliveredQty.toString()).toBe('0');

    const seenFromA = await withTenant(companyAId, (tx) => tx.salesOrderLine.findMany({ where: { id: line.id } }));
    const seenFromB = await withTenant(companyBId, (tx) => tx.salesOrderLine.findMany({ where: { id: line.id } }));
    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
    const updatedFromB = await withTenant(companyBId, (tx) =>
      tx.salesOrderLine.updateMany({ where: { id: line.id }, data: { deliveredQty: '1' } }),
    );
    expect(updatedFromB.count).toBe(0);

    await expect(
      withTenant(companyAId, (tx) => tx.salesOrderLine.update({ where: { id: line.id }, data: { deliveredQty: '5.001' } })),
    ).rejects.toThrow(/SalesOrderLine_deliveredQty_range_check/);
    await expect(
      withTenant(companyAId, (tx) => tx.salesOrderLine.update({ where: { id: line.id }, data: { deliveredQty: '-1' } })),
    ).rejects.toThrow(/SalesOrderLine_deliveredQty_range_check/);
    const full = await withTenant(companyAId, (tx) =>
      tx.salesOrderLine.update({ where: { id: line.id }, data: { deliveredQty: '5' } }),
    );
    expect(full.deliveredQty.toString()).toBe('5');
  });

  it('rejects a SalesOrder pointing at another tenant’s customer/outlet/warehouse', async () => {
    const base = {
      companyId: companyAId,
      customerId: customerAId,
      outletId: outletAId,
      warehouseId: warehouseAId,
    };

    await expect(
      systemPrisma.salesOrder.create({ data: { ...base, number: 'ISO-XT-1', customerId: customerBId } }),
    ).rejects.toThrow(/cross-tenant/i);

    await expect(
      systemPrisma.salesOrder.create({ data: { ...base, number: 'ISO-XT-2', outletId: outletBId } }),
    ).rejects.toThrow(/cross-tenant/i);

    await expect(
      systemPrisma.salesOrder.create({ data: { ...base, number: 'ISO-XT-3', warehouseId: warehouseBId } }),
    ).rejects.toThrow(/cross-tenant/i);

    // The all-company-A version of the same row must still be accepted, so
    // this is proving the guard is selective and not just "always throws".
    const ok = await withTenant(companyAId, (tx) => tx.salesOrder.create({ data: { ...base, number: 'ISO-XT-OK' } }));
    expect(ok.companyId).toBe(companyAId);
  });

  it('rejects a StockLevel joining another tenant’s product to this tenant’s warehouse', async () => {
    await expect(
      systemPrisma.stockLevel.create({ data: { productId: productBId, warehouseId: warehouseAId } }),
    ).rejects.toThrow(/cross-tenant/i);

    const ok = await withTenant(companyAId, (tx) =>
      tx.stockLevel.create({ data: { productId: productAId, warehouseId: warehouseAId } }),
    );
    expect(ok.productId).toBe(productAId);
  });

  it('rejects a PriceListItem joining another tenant’s product', async () => {
    await expect(
      systemPrisma.priceListItem.create({ data: { priceListId: priceListAId, productId: productBId, price: 100 } }),
    ).rejects.toThrow(/cross-tenant/i);

    const ok = await withTenant(companyAId, (tx) =>
      tx.priceListItem.create({ data: { priceListId: priceListAId, productId: productAId, price: 100 } }),
    );
    expect(ok.priceListId).toBe(priceListAId);
  });

  it('rejects a RouteStop joining another tenant’s outlet', async () => {
    await expect(
      systemPrisma.routeStop.create({ data: { routeId: routeAId, outletId: outletBId, sortOrder: 1 } }),
    ).rejects.toThrow(/cross-tenant/i);

    const ok = await withTenant(companyAId, (tx) =>
      tx.routeStop.create({ data: { routeId: routeAId, outletId: outletAId, sortOrder: 1 } }),
    );
    expect(ok.outletId).toBe(outletAId);
  });

  // The courier link (20260810170000_couriers_replace_suppliers) is a column on
  // two tables that were already RLS-protected, so this asserts the existing
  // `tenant_isolation` policy really does cover it (a policy is per-table, not
  // per-column) — including through the new User back-relations
  // (`courierOrders`/`courierRoutes`), which are a fresh join path into another
  // tenant's rows.
  it('a SalesOrder/Route carrying a courierId is invisible cross-tenant', async () => {
    const ordersFromA = await withTenant(companyAId, (tx) =>
      tx.salesOrder.findMany({ where: { courierId: { not: null } } }),
    );
    expect(ordersFromA.map((o) => o.id)).toEqual([deliveryOrderAId]);
    expect(ordersFromA[0]?.courierId).toBe(courierAId);

    const ordersFromB = await withTenant(companyBId, (tx) =>
      tx.salesOrder.findMany({ where: { courierId: { not: null } } }),
    );
    expect(ordersFromB).toHaveLength(0);

    // Filtering by the other tenant's courier id must be indistinguishable
    // from "no such user" — otherwise the filter is an existence oracle.
    const probedOrders = await withTenant(companyBId, (tx) =>
      tx.salesOrder.findMany({ where: { courierId: courierAId } }),
    );
    expect(probedOrders).toHaveLength(0);
    const probedOrder = await withTenant(companyBId, (tx) =>
      tx.salesOrder.findUnique({ where: { id: deliveryOrderAId } }),
    );
    expect(probedOrder).toBeNull();

    const routeFromA = await withTenant(companyAId, (tx) =>
      tx.route.findUnique({ where: { id: deliveryRouteAId } }),
    );
    expect(routeFromA?.courierId).toBe(courierAId);
    expect(routeFromA?.agentId).toBeNull();
    const routesFromB = await withTenant(companyBId, (tx) =>
      tx.route.findMany({ where: { courierId: courierAId } }),
    );
    expect(routesFromB).toHaveLength(0);
    const probedRoute = await withTenant(companyBId, (tx) =>
      tx.route.findUnique({ where: { id: deliveryRouteAId } }),
    );
    expect(probedRoute).toBeNull();

    // ...and neither link leaks through the courier's own User row.
    const viaUser = await withTenant(companyBId, (tx) =>
      tx.user.findMany({ include: { courierOrders: true, courierRoutes: true } }),
    );
    expect(viaUser.map((u) => u.id)).not.toContain(courierAId);
    expect(viaUser.flatMap((u) => u.courierOrders)).toHaveLength(0);
    expect(viaUser.flatMap((u) => u.courierRoutes)).toHaveLength(0);
  });

  it('rejects a SalesOrder/Route whose courier is another tenant’s user', async () => {
    await expect(
      systemPrisma.salesOrder.create({
        data: {
          companyId: companyAId,
          number: 'ISO-COU-XT',
          customerId: customerAId,
          warehouseId: warehouseAId,
          courierId: userBId,
        },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    // UPDATE is guarded too, not just INSERT: re-assigning an existing route's
    // courier is the easier way to stitch two tenants together. Re-pointing
    // the already-courier-served route keeps the agent/courier XOR satisfied,
    // so this asserts the cross-tenant guard and not the CHECK constraint.
    await expect(
      systemPrisma.route.update({ where: { id: deliveryRouteAId }, data: { courierId: userBId } }),
    ).rejects.toThrow(/cross-tenant/i);

    const untouched = await systemPrisma.route.findUnique({ where: { id: deliveryRouteAId } });
    expect(untouched?.courierId).toBe(courierAId);

    // Selective, not "always throws": the all-company-A assignment is accepted.
    const ok = await withTenant(companyAId, (tx) =>
      tx.salesOrder.create({
        data: {
          companyId: companyAId,
          number: 'ISO-COU-OK',
          customerId: customerAId,
          warehouseId: warehouseAId,
          courierId: courierAId,
        },
      }),
    );
    expect(ok.courierId).toBe(courierAId);
    await systemPrisma.salesOrder.delete({ where: { id: ok.id } });
  });

  // "Route"."agentId" is nullable, so the only thing standing between the
  // schema and an ownerless (or double-owned) route is the CHECK constraint
  // `Route_agent_xor_courier_check`. Enforced in the database, not in a
  // service, so it holds for the miniapp sync path and for BYPASSRLS
  // `velto_system` too.
  it('rejects a Route with neither an agent nor a courier', async () => {
    await expect(
      withTenant(companyAId, (tx) =>
        tx.route.create({ data: { companyId: companyAId, weekday: 6, name: 'Ownerless Route' } }),
      ),
    ).rejects.toThrow(/Route_agent_xor_courier_check|check constraint/i);

    // Same for an UPDATE that strips the last owner off an existing route.
    await expect(
      systemPrisma.route.update({ where: { id: routeAId }, data: { agentId: null } }),
    ).rejects.toThrow(/Route_agent_xor_courier_check|check constraint/i);

    const stillOwned = await systemPrisma.route.findUnique({ where: { id: routeAId } });
    expect(stillOwned?.agentId).toBe(recipientId);
  });

  it('rejects a Route assigned to both an agent and a courier', async () => {
    await expect(
      withTenant(companyAId, (tx) =>
        tx.route.create({
          data: {
            companyId: companyAId,
            agentId: recipientId,
            courierId: courierAId,
            weekday: 6,
            name: 'Double-owned Route',
          },
        }),
      ),
    ).rejects.toThrow(/Route_agent_xor_courier_check|check constraint/i);

    // Adding a courier to an agent route, and an agent to a courier route,
    // are the two realistic ways an API handler would break the invariant.
    await expect(
      systemPrisma.route.update({ where: { id: routeAId }, data: { courierId: courierAId } }),
    ).rejects.toThrow(/Route_agent_xor_courier_check|check constraint/i);

    await expect(
      systemPrisma.route.update({ where: { id: deliveryRouteAId }, data: { agentId: recipientId } }),
    ).rejects.toThrow(/Route_agent_xor_courier_check|check constraint/i);

    // Selective, not "always throws": both single-owner shapes are accepted,
    // and swapping one owner for the other in a single statement is legal.
    const agentOnly = await withTenant(companyAId, (tx) =>
      tx.route.create({ data: { companyId: companyAId, agentId: recipientId, weekday: 6, name: 'Agent Route' } }),
    );
    const swapped = await withTenant(companyAId, (tx) =>
      tx.route.update({ where: { id: agentOnly.id }, data: { agentId: null, courierId: courierAId } }),
    );
    expect(swapped.agentId).toBeNull();
    expect(swapped.courierId).toBe(courierAId);

    await systemPrisma.route.delete({ where: { id: agentOnly.id } });
  });

  // Before 20260808120000 these keys were globally unique, so tenant A writing
  // a clientId/telegramId could collide with tenant B's row — a write-failure
  // oracle for "does this id exist in some other company?".
  it('offline idempotency keys (clientId) are unique per company, not globally', async () => {
    const clientId = `iso-shared-${Date.now()}`;

    const inA = await withTenant(companyAId, (tx) =>
      tx.salesOrder.create({
        data: { companyId: companyAId, number: 'ISO-CID-A', customerId: customerAId, warehouseId: warehouseAId, clientId },
      }),
    );
    const inB = await withTenant(companyBId, (tx) =>
      tx.salesOrder.create({
        data: { companyId: companyBId, number: 'ISO-CID-B', customerId: customerBId, warehouseId: warehouseBId, clientId },
      }),
    );
    expect(inA.clientId).toBe(inB.clientId);

    // Still unique *within* a company — idempotent resubmit protection (10.4).
    await expect(
      withTenant(companyAId, (tx) =>
        tx.salesOrder.create({
          data: { companyId: companyAId, number: 'ISO-CID-A2', customerId: customerAId, warehouseId: warehouseAId, clientId },
        }),
      ),
    ).rejects.toThrow();
  });

  it('User.telegramId is unique per company, not globally', async () => {
    const telegramId = BigInt(Date.now());

    const users = await Promise.all([
      systemPrisma.user.create({
        data: { companyId: companyAId, firstName: 'Tg', lastName: 'A', phone: '+998900000095', telegramId },
      }),
      systemPrisma.user.create({
        data: { companyId: companyBId, firstName: 'Tg', lastName: 'B', phone: '+998900000094', telegramId },
      }),
    ]);
    expect(users).toHaveLength(2);

    await expect(
      systemPrisma.user.create({
        data: { companyId: companyAId, firstName: 'Tg', lastName: 'A2', phone: '+998900000093', telegramId },
      }),
    ).rejects.toThrow();

    await systemPrisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  });

  // `@@unique([companyId, name, parentId])` does not constrain root categories
  // at all, because NULL <> NULL in a btree — covered by a partial unique
  // index instead.
  it('root ProductCategory names are unique per company', async () => {
    await withTenant(companyAId, (tx) => tx.productCategory.create({ data: { companyId: companyAId, name: 'Root Iso' } }));

    await expect(
      withTenant(companyAId, (tx) => tx.productCategory.create({ data: { companyId: companyAId, name: 'Root Iso' } })),
    ).rejects.toThrow();

    // ...but the same root name in another company is fine.
    const inB = await withTenant(companyBId, (tx) =>
      tx.productCategory.create({ data: { companyId: companyBId, name: 'Root Iso' } }),
    );
    expect(inB.name).toBe('Root Iso');
  });

  it('a parent-subquery child table (RolePermission via Role) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) =>
      tx.rolePermission.findMany({ where: { permissionId } }),
    );
    const seenFromB = await withTenant(companyBId, (tx) =>
      tx.rolePermission.findMany({ where: { permissionId } }),
    );

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  // Every case above only proves reads are scoped. RLS also has to stop
  // *writes* aimed at another tenant: a `CREATE POLICY ... USING (...)` with
  // no explicit WITH CHECK reuses the USING expression as the INSERT/UPDATE
  // check, so these assert that behavior is actually in place rather than
  // assumed.
  it('rejects an INSERT that claims another tenant’s companyId', async () => {
    await expect(
      withTenant(companyAId, (tx) =>
        tx.customer.create({ data: { companyId: companyBId, code: 'SMUGGLED', name: 'Smuggled into B' } }),
      ),
    ).rejects.toThrow(/row-level security/i);

    const inB = await withTenant(companyBId, (tx) => tx.customer.findMany({ where: { code: 'SMUGGLED' } }));
    expect(inB).toHaveLength(0);
  });

  it('cannot UPDATE or DELETE another tenant’s row (invisible, never matched)', async () => {
    const updated = await withTenant(companyAId, (tx) =>
      tx.customer.updateMany({ where: { id: customerBId }, data: { name: 'Hijacked' } }),
    );
    expect(updated.count).toBe(0);

    const deleted = await withTenant(companyAId, (tx) =>
      tx.customer.deleteMany({ where: { id: customerBId } }),
    );
    expect(deleted.count).toBe(0);

    const stillThere = await withTenant(companyBId, (tx) => tx.customer.findUnique({ where: { id: customerBId } }));
    expect(stillThere?.name).toBe('Customer B');
  });

  // Guard rail for 6.10 / SEC-001..005: a new tenant-scoped table whose
  // migration forgets the policy (or forgets FORCE, which silently exempts
  // the app's own owning role) fails here instead of leaking in production.
  it('every table with a companyId column has RLS enabled, FORCEd, and a policy', async () => {
    const unprotected = await systemPrisma.$queryRaw<{ relname: string; reason: string }[]>`
      SELECT c.relname,
             CASE
               WHEN NOT c.relrowsecurity THEN 'RLS not enabled'
               WHEN NOT c.relforcerowsecurity THEN 'FORCE ROW LEVEL SECURITY missing'
               ELSE 'no policy'
             END AS reason
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'companyId' AND NOT a.attisdropped
        )
        AND (
          NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
        )
      ORDER BY c.relname
    `;

    expect(unprotected).toEqual([]);
  });

  it('fails closed (never leaks) when no tenant context is set', async () => {
    // On a pooled connection previously used by withTenant(), Postgres
    // reverts a custom GUC to '' (not NULL) once the setting transaction
    // ends, since custom parameters have no true "unset" state — so the
    // ::uuid cast in the RLS policy can throw instead of matching zero rows.
    // Both outcomes are safe (neither leaks another tenant's rows); a test
    // that depends on which one happens would just be testing connection
    // pool timing, not the security property.
    try {
      const rows = await prisma.customer.findMany({
        where: { companyId: { in: [companyAId, companyBId] } },
      });
      expect(rows).toHaveLength(0);
    } catch (err) {
      expect(String(err)).toMatch(/uuid/i);
    }
  });

  it('AuditLog is append-only — UPDATE and DELETE are rejected even for the owning role', async () => {
    const log = await withTenant(companyAId, (tx) =>
      tx.auditLog.create({
        data: { companyId: companyAId, action: 'test.action', entity: 'Test', entityId: companyAId },
      }),
    );

    await expect(
      withTenant(companyAId, (tx) =>
        tx.$executeRaw`UPDATE "AuditLog" SET action = 'changed' WHERE id = ${log.id}::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      withTenant(companyAId, (tx) => tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${log.id}::uuid`),
    ).rejects.toThrow(/append-only/i);

    // TRUNCATE fires statement-level triggers, not row-level ones — the
    // UPDATE/DELETE guard above doesn't cover it on its own (20260730224500).
    await expect(
      withTenant(companyAId, (tx) => tx.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')),
    ).rejects.toThrow(TRUNCATE_REJECTED);

    // No cleanup: the row is append-only by design, even for the BYPASSRLS
    // role — this one test log entry is expected to remain in dev/test data.
  });

  // F2.1: payment / stock-movement reversal. PaymentReversal is a new
  // direct-companyId table; Payment/PaymentAllocation/StockMovement/
  // PaymentReversal are append-only except Payment.status POSTED -> REVERSED.
  describe('F2.1 reversal tables and append-only locks', () => {
    let payCustomerId: string;
    let invoiceId: string;
    let paymentId: string;
    let allocationId: string;
    let actorId: string;
    let movementAId: string;
    let movementBId: string;

    beforeAll(async () => {
      const actor = await systemPrisma.user.create({
        data: {
          companyId: companyAId,
          firstName: 'Reversal',
          lastName: 'Actor',
          phone: `+99891${Date.now().toString().slice(-7)}`,
        },
      });
      actorId = actor.id;
      await withTenant(companyAId, async (tx) => {
        const customer = await tx.customer.create({ data: { companyId: companyAId, code: 'A-PAY', name: 'Payer A' } });
        payCustomerId = customer.id;
        const invoice = await tx.invoice.create({
          data: { companyId: companyAId, number: 'INV-ISO-1', customerId: payCustomerId, total: '100.00' },
        });
        invoiceId = invoice.id;
        const payment = await tx.payment.create({
          data: { companyId: companyAId, number: 'PAY-ISO-1', customerId: payCustomerId, amount: '100.00', method: 'CASH' },
        });
        paymentId = payment.id;
        const allocation = await tx.paymentAllocation.create({
          data: { paymentId, invoiceId, amount: '100.00' },
        });
        allocationId = allocation.id;
        const movement = await tx.stockMovement.create({
          data: { companyId: companyAId, productId: productAId, warehouseId: warehouseAId, type: 'ADJUST', qty: '2.000' },
        });
        movementAId = movement.id;
      });
      const movementB = await withTenant(companyBId, (tx) =>
        tx.stockMovement.create({
          data: { companyId: companyBId, productId: productBId, warehouseId: warehouseBId, type: 'ADJUST', qty: '1.000' },
        }),
      );
      movementBId = movementB.id;
    });

    it('Payment.status defaults to POSTED', async () => {
      const p = await withTenant(companyAId, (tx) => tx.payment.findUnique({ where: { id: paymentId } }));
      expect(p?.status).toBe('POSTED');
    });

    it('Payment cannot flip to REVERSED before its PaymentReversal row exists', async () => {
      await expect(
        withTenant(companyAId, (tx) => tx.payment.update({ where: { id: paymentId }, data: { status: 'REVERSED' } })),
      ).rejects.toThrow(/PaymentReversal/);
    });

    it('PaymentReversal rejects a cross-tenant payment or actor and an empty reason', async () => {
      // Company B cannot reverse company A's payment …
      await expect(
        withTenant(companyBId, (tx) =>
          tx.paymentReversal.create({
            data: { companyId: companyBId, reversesPaymentId: paymentId, reason: 'x', actorId: userBId },
          }),
        ),
      ).rejects.toThrow();
      // … nor can company A record company B's user as the actor.
      await expect(
        withTenant(companyAId, (tx) =>
          tx.paymentReversal.create({
            data: { companyId: companyAId, reversesPaymentId: paymentId, reason: 'x', actorId: userBId },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(companyAId, (tx) =>
          tx.paymentReversal.create({
            data: { companyId: companyAId, reversesPaymentId: paymentId, reason: '  ', actorId },
          }),
        ),
      ).rejects.toThrow();
    });

    it('a direct-companyId table (PaymentReversal) is scoped per tenant; Payment flips POSTED -> REVERSED once', async () => {
      await withTenant(companyAId, async (tx) => {
        await tx.paymentReversal.create({
          data: { companyId: companyAId, reversesPaymentId: paymentId, reason: 'duplicate entry', actorId },
        });
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'REVERSED' } });
      });

      const seenFromA = await withTenant(companyAId, (tx) => tx.paymentReversal.findMany());
      const seenFromB = await withTenant(companyBId, (tx) => tx.paymentReversal.findMany());
      expect(seenFromA.map((r) => r.reversesPaymentId)).toEqual([paymentId]);
      expect(seenFromB).toHaveLength(0);
      try {
        expect(await prisma.paymentReversal.findMany()).toHaveLength(0);
      } catch (err) {
        expect(String(err)).toMatch(/uuid/i);
      }

      // One reversal per payment.
      await expect(
        withTenant(companyAId, (tx) =>
          tx.paymentReversal.create({
            data: { companyId: companyAId, reversesPaymentId: paymentId, reason: 'again', actorId },
          }),
        ),
      ).rejects.toThrow();
      // REVERSED is terminal.
      await expect(
        withTenant(companyAId, (tx) => tx.payment.update({ where: { id: paymentId }, data: { status: 'POSTED' } })),
      ).rejects.toThrow(/append-only/i);
      const p = await withTenant(companyAId, (tx) => tx.payment.findUnique({ where: { id: paymentId } }));
      expect(p?.status).toBe('REVERSED');
      expect(p?.amount.toString()).toBe('100');
    });

    it('Payment/PaymentAllocation/PaymentReversal are append-only — UPDATE/DELETE/TRUNCATE rejected, even for velto_system', async () => {
      await expect(
        withTenant(companyAId, (tx) => tx.$executeRaw`UPDATE "Payment" SET amount = 1 WHERE id = ${paymentId}::uuid`),
      ).rejects.toThrow(/append-only/i);
      await expect(
        withTenant(companyAId, (tx) => tx.$executeRaw`DELETE FROM "Payment" WHERE id = ${paymentId}::uuid`),
      ).rejects.toThrow(/append-only/i);
      await expect(
        withTenant(companyAId, (tx) =>
          tx.$executeRaw`UPDATE "PaymentAllocation" SET amount = 1 WHERE id = ${allocationId}::uuid`,
        ),
      ).rejects.toThrow(/append-only/i);
      await expect(
        withTenant(companyAId, (tx) => tx.$executeRaw`DELETE FROM "PaymentAllocation" WHERE id = ${allocationId}::uuid`),
      ).rejects.toThrow(/append-only/i);
      await expect(
        withTenant(companyAId, (tx) =>
          tx.$executeRaw`UPDATE "PaymentReversal" SET reason = 'changed' WHERE "reversesPaymentId" = ${paymentId}::uuid`,
        ),
      ).rejects.toThrow(/append-only/i);
      await expect(
        withTenant(companyAId, (tx) =>
          tx.$executeRaw`DELETE FROM "PaymentReversal" WHERE "reversesPaymentId" = ${paymentId}::uuid`,
        ),
      ).rejects.toThrow(/append-only/i);
      for (const table of ['Payment', 'PaymentAllocation', 'PaymentReversal']) {
        await expect(
          withTenant(companyAId, (tx) => tx.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)),
        ).rejects.toThrow(TRUNCATE_REJECTED);
      }

      // BYPASSRLS does not skip triggers.
      await expect(
        systemPrisma.payment.update({ where: { id: paymentId }, data: { method: 'CARD' } }),
      ).rejects.toThrow(/append-only/i);
      await expect(systemPrisma.payment.delete({ where: { id: paymentId } })).rejects.toThrow(/append-only/i);
      await expect(
        systemPrisma.paymentAllocation.update({ where: { id: allocationId }, data: { amount: '1.00' } }),
      ).rejects.toThrow(/append-only/i);
      await expect(
        systemPrisma.paymentAllocation.deleteMany({ where: { id: allocationId } }),
      ).rejects.toThrow(/append-only/i);

      const alloc = await withTenant(companyAId, (tx) => tx.paymentAllocation.findUnique({ where: { id: allocationId } }));
      expect(alloc?.amount.toString()).toBe('100');
    });

    it('StockMovement is append-only; a reversal is a new row (reason required, once, same tenant)', async () => {
      await expect(
        withTenant(companyAId, (tx) => tx.$executeRaw`UPDATE "StockMovement" SET qty = 9 WHERE id = ${movementAId}::uuid`),
      ).rejects.toThrow(/append-only/i);
      await expect(
        withTenant(companyAId, (tx) => tx.$executeRaw`DELETE FROM "StockMovement" WHERE id = ${movementAId}::uuid`),
      ).rejects.toThrow(/append-only/i);
      await expect(
        withTenant(companyAId, (tx) => tx.$executeRawUnsafe('TRUNCATE TABLE "StockMovement"')),
      ).rejects.toThrow(TRUNCATE_REJECTED);
      await expect(
        systemPrisma.stockMovement.update({ where: { id: movementAId }, data: { note: 'changed' } }),
      ).rejects.toThrow(/append-only/i);
      await expect(systemPrisma.stockMovement.delete({ where: { id: movementAId } })).rejects.toThrow(/append-only/i);

      const reversal = (extra: { reason?: string; reversesMovementId: string }) => ({
        companyId: companyAId,
        productId: productAId,
        warehouseId: warehouseAId,
        type: 'ADJUST' as const,
        qty: '-2.000',
        ...extra,
      });
      // Reason required.
      await expect(
        withTenant(companyAId, (tx) => tx.stockMovement.create({ data: reversal({ reversesMovementId: movementAId }) })),
      ).rejects.toThrow();
      // Cannot reverse another tenant's movement.
      await expect(
        withTenant(companyAId, (tx) =>
          tx.stockMovement.create({ data: reversal({ reversesMovementId: movementBId, reason: 'x' }) }),
        ),
      ).rejects.toThrow();
      const rev = await withTenant(companyAId, (tx) =>
        tx.stockMovement.create({ data: reversal({ reversesMovementId: movementAId, reason: 'miscount' }) }),
      );
      expect(rev.reversesMovementId).toBe(movementAId);
      // At most one reversal per movement.
      await expect(
        withTenant(companyAId, (tx) =>
          tx.stockMovement.create({ data: reversal({ reversesMovementId: movementAId, reason: 'again' }) }),
        ),
      ).rejects.toThrow();
      // Invisible cross-tenant.
      const fromB = await withTenant(companyBId, (tx) => tx.stockMovement.findMany({ where: { id: rev.id } }));
      expect(fromB).toHaveLength(0);
    });
  });

  describe('F2.5 reconciliation tables (ReconciliationRun / ReconciliationFinding)', () => {
    let runAId: string;
    let runBId: string;
    const stockFinding = (runId: string, extra: Record<string, unknown> = {}) => ({
      companyId: companyAId,
      runId,
      lastRunId: runId,
      kind: 'STOCK' as const,
      productId: productAId,
      warehouseId: warehouseAId,
      expectedOnHand: '10.000',
      actualOnHand: '12.000',
      diffOnHand: '2.000',
      expectedReserved: '0.000',
      actualReserved: '0.000',
      diffReserved: '0.000',
      ...extra,
    });
    const balanceFinding = (runId: string, extra: Record<string, unknown> = {}) => ({
      companyId: companyAId,
      runId,
      lastRunId: runId,
      kind: 'BALANCE' as const,
      customerId: customerAId,
      expectedBalance: '100.00',
      actualBalance: '90.00',
      diffBalance: '-10.00',
      ...extra,
    });

    beforeAll(async () => {
      const runA = await withTenant(companyAId, (tx) =>
        tx.reconciliationRun.create({ data: { companyId: companyAId, trigger: 'MANUAL', triggeredById: courierAId } }),
      );
      runAId = runA.id;
      const runB = await withTenant(companyBId, (tx) =>
        tx.reconciliationRun.create({ data: { companyId: companyBId, trigger: 'SCHEDULED' } }),
      );
      runBId = runB.id;
      await withTenant(companyAId, (tx) => tx.reconciliationFinding.create({ data: stockFinding(runAId) }));
    });

    it('runs and findings are scoped per tenant and fail closed without a tenant context', async () => {
      const [runsA, findingsA] = await withTenant(companyAId, (tx) =>
        Promise.all([tx.reconciliationRun.findMany(), tx.reconciliationFinding.findMany()]),
      );
      const [runsB, findingsB] = await withTenant(companyBId, (tx) =>
        Promise.all([tx.reconciliationRun.findMany(), tx.reconciliationFinding.findMany()]),
      );
      expect(runsA.map((r) => r.id)).toEqual([runAId]);
      expect(findingsA).toHaveLength(1);
      expect(findingsA[0]!.status).toBe('OPEN');
      expect(runsB.map((r) => r.id)).toEqual([runBId]);
      expect(findingsB).toHaveLength(0);
      // Outside withTenant: zero rows or the '' GUC ::uuid cast error — both
      // fail closed (see the generic fail-closed case above).
      for (const read of [() => prisma.reconciliationRun.findMany(), () => prisma.reconciliationFinding.findMany()]) {
        try {
          expect(await read()).toHaveLength(0);
        } catch (err) {
          expect(String(err)).toMatch(/uuid/i);
        }
      }
    });

    it('rejects cross-tenant run/product/warehouse/customer/user references', async () => {
      const bad: Record<string, unknown>[] = [
        stockFinding(runAId, { runId: runBId }),
        stockFinding(runAId, { lastRunId: runBId }),
        stockFinding(runAId, { productId: productBId }),
        stockFinding(runAId, { warehouseId: warehouseBId }),
        balanceFinding(runAId, { customerId: customerBId }),
      ];
      for (const data of bad) {
        await expect(
          withTenant(companyAId, (tx) => tx.reconciliationFinding.create({ data: data as never })),
        ).rejects.toThrow();
      }
      await expect(
        withTenant(companyAId, (tx) =>
          tx.reconciliationRun.create({ data: { companyId: companyAId, trigger: 'MANUAL', triggeredById: userBId } }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(companyAId, (tx) =>
          tx.reconciliationRun.create({ data: { companyId: companyBId, trigger: 'SCHEDULED' } }),
        ),
      ).rejects.toThrow();
    });

    it('enforces per-kind shape, diff = actual − expected, and MANUAL ⇒ triggeredBy', async () => {
      const bad: Record<string, unknown>[] = [
        stockFinding(runAId, { productId: null }),
        stockFinding(runAId, { customerId: customerAId }),
        stockFinding(runAId, { diffOnHand: '5.000' }),
        stockFinding(runAId, { expectedBalance: '1.00', actualBalance: '1.00', diffBalance: '0.00' }),
        balanceFinding(runAId, { diffBalance: '10.00' }),
        stockFinding(runAId, { status: 'FIXED' }),
      ];
      for (const data of bad) {
        await expect(
          withTenant(companyAId, (tx) => tx.reconciliationFinding.create({ data: data as never })),
        ).rejects.toThrow();
      }
      await expect(
        withTenant(companyAId, (tx) => tx.reconciliationRun.create({ data: { companyId: companyAId, trigger: 'MANUAL' } })),
      ).rejects.toThrow();
    });

    it('at most one OPEN finding per (company, kind, subject); FIXED frees the slot', async () => {
      await expect(
        withTenant(companyAId, (tx) => tx.reconciliationFinding.create({ data: stockFinding(runAId) })),
      ).rejects.toThrow();
      const balance = await withTenant(companyAId, (tx) => tx.reconciliationFinding.create({ data: balanceFinding(runAId) }));
      await expect(
        withTenant(companyAId, (tx) => tx.reconciliationFinding.create({ data: balanceFinding(runAId) })),
      ).rejects.toThrow();
      await withTenant(companyAId, (tx) =>
        tx.reconciliationFinding.update({
          where: { id: balance.id },
          data: { status: 'FIXED', fixedAt: new Date(), fixedById: courierAId },
        }),
      );
      const reopened = await withTenant(companyAId, (tx) => tx.reconciliationFinding.create({ data: balanceFinding(runAId) }));
      expect(reopened.status).toBe('OPEN');
      // A FIXED finding cannot name another tenant's user as fixer.
      await expect(
        withTenant(companyAId, (tx) =>
          tx.reconciliationFinding.update({
            where: { id: reopened.id },
            data: { status: 'FIXED', fixedAt: new Date(), fixedById: userBId },
          }),
        ),
      ).rejects.toThrow();
      // Company B cannot touch A's finding (invisible → no match).
      const touched = await withTenant(companyBId, (tx) =>
        tx.reconciliationFinding.updateMany({ where: { id: reopened.id }, data: { lastRunId: runBId } }),
      );
      expect(touched.count).toBe(0);
    });
  });

  describe('F3 Visit GPS status / SKIPPED and Company GPS thresholds', () => {
    const base = () => ({
      companyId: companyAId,
      agentId: courierAId,
      outletId: outletAId,
      startedAt: new Date(),
    });
    const CHECK = /check constraint|violates/i;

    afterAll(async () => {
      await systemPrisma.visit.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    });

    it('Company thresholds default to 150/100 and are range-checked', async () => {
      const company = await withTenant(companyAId, (tx) => tx.company.findUniqueOrThrow({ where: { id: companyAId } }));
      expect(company.visitGpsRadiusM).toBe(150);
      expect(company.gpsMaxAccuracyM).toBe(100);
      for (const data of [{ visitGpsRadiusM: 9 }, { visitGpsRadiusM: 5001 }]) {
        await expect(
          withTenant(companyAId, (tx) => tx.company.update({ where: { id: companyAId }, data })),
        ).rejects.toThrow(/Company_visitGpsRadiusM_range_check|check constraint/i);
      }
      for (const data of [{ gpsMaxAccuracyM: 4 }, { gpsMaxAccuracyM: 1001 }]) {
        await expect(
          withTenant(companyAId, (tx) => tx.company.update({ where: { id: companyAId }, data })),
        ).rejects.toThrow(/Company_gpsMaxAccuracyM_range_check|check constraint/i);
      }
      // Another tenant cannot change A's thresholds (invisible, never matched).
      const touched = await withTenant(companyBId, (tx) =>
        tx.company.updateMany({ where: { id: companyAId }, data: { visitGpsRadiusM: 500 } }),
      );
      expect(touched.count).toBe(0);
    });

    it('a Visit with gpsStatus/skipReason is scoped per tenant; gpsOk is derived from gpsStatus', async () => {
      const verified = await withTenant(companyAId, (tx) =>
        tx.visit.create({
          data: {
            ...base(),
            latitude: 41.3,
            longitude: 69.2,
            gpsStatus: 'VERIFIED',
            gpsAccuracyM: 12.5,
            gpsCapturedAt: new Date(),
            distanceM: 40,
            gpsOk: false, // overwritten by the Visit_gps_sync trigger
            outcome: 'ORDERED',
          },
        }),
      );
      expect(verified.gpsOk).toBe(true);
      const skipped = await withTenant(companyAId, (tx) =>
        tx.visit.create({
          data: { ...base(), gpsStatus: 'NO_PERMISSION', outcome: 'SKIPPED', skipReason: 'Yopiq edi' },
        }),
      );
      expect(skipped.gpsOk).toBeNull();
      expect(skipped.latitude).toBeNull();

      const seenFromA = await withTenant(companyAId, (tx) => tx.visit.findMany({ where: { companyId: companyAId } }));
      const seenFromB = await withTenant(companyBId, (tx) => tx.visit.findMany());
      expect(new Set(seenFromA.map((v) => v.id))).toEqual(new Set([verified.id, skipped.id]));
      expect(seenFromB).toHaveLength(0);
      const touched = await withTenant(companyBId, (tx) =>
        tx.visit.updateMany({ where: { id: skipped.id }, data: { skipReason: 'x' } }),
      );
      expect(touched.count).toBe(0);
    });

    it('a pre-F3 writer (coords + gpsOk, no status) gets gpsStatus derived', async () => {
      const legacy = await withTenant(companyAId, (tx) =>
        tx.visit.create({ data: { ...base(), latitude: 41.3, longitude: 69.2, gpsOk: true, outcome: 'NO_ORDER' } }),
      );
      expect(legacy.gpsStatus).toBe('VERIFIED');
      const noOutletCoords = await withTenant(companyAId, (tx) =>
        tx.visit.create({ data: { ...base(), latitude: 41.3, longitude: 69.2, gpsOk: null, outcome: 'NO_ORDER' } }),
      );
      expect(noOutletCoords.gpsStatus).toBe('OUTLET_NO_COORDS');
    });

    it('rejects half coordinates, status/coords mismatch, negative metrics and bad skipReason', async () => {
      const rejected = [
        // Visit_coords_pair_check
        { latitude: 41.3, gpsStatus: 'LOW_ACCURACY', outcome: 'ORDERED' },
        // Visit_gpsStatus_coords_check: VERIFIED without coordinates
        { gpsStatus: 'VERIFIED', outcome: 'ORDERED' },
        // Visit_gpsStatus_coords_check: NO_FIX with GPS metadata and coordinates
        { latitude: 41.3, longitude: 69.2, gpsStatus: 'NO_FIX', gpsCapturedAt: new Date(), outcome: 'ORDERED' },
        // Visit_gps_metrics_nonneg_check
        { latitude: 41.3, longitude: 69.2, gpsStatus: 'VERIFIED', distanceM: -1, outcome: 'ORDERED' },
        { latitude: 41.3, longitude: 69.2, gpsStatus: 'VERIFIED', gpsAccuracyM: -1, outcome: 'ORDERED' },
        // Visit_skipReason_check: SKIPPED without / with blank reason, reason on a non-skip
        { gpsStatus: 'NO_FIX', outcome: 'SKIPPED' },
        { gpsStatus: 'NO_FIX', outcome: 'SKIPPED', skipReason: '   ' },
        { gpsStatus: 'NO_FIX', outcome: 'NO_ORDER', skipReason: 'Yopiq edi' },
      ] as const;
      for (const data of rejected) {
        await expect(
          withTenant(companyAId, (tx) => tx.visit.create({ data: { ...base(), ...data } })),
        ).rejects.toThrow(CHECK);
      }
    });

    // 20261013190000_visit_route_fk_guards: FK guards fire for every writer,
    // including BYPASSRLS velto_system.
    it('rejects a Visit/Route/RouteRun referencing another tenant’s user/outlet/route (even via velto_system)', async () => {
      const CROSS = /cross-tenant/i;
      for (const data of [
        { ...base(), agentId: userBId, outcome: 'NO_ORDER' as const },
        { ...base(), outletId: outletBId, outcome: 'NO_ORDER' as const },
      ]) {
        await expect(withTenant(companyAId, (tx) => tx.visit.create({ data }))).rejects.toThrow(CROSS);
        await expect(systemPrisma.visit.create({ data })).rejects.toThrow(CROSS);
      }
      const ok = await systemPrisma.visit.create({ data: { ...base(), outcome: 'NO_ORDER' } });
      await expect(
        systemPrisma.visit.update({ where: { id: ok.id }, data: { agentId: userBId } }),
      ).rejects.toThrow(CROSS);
      await expect(
        systemPrisma.visit.update({ where: { id: ok.id }, data: { outletId: outletBId } }),
      ).rejects.toThrow(CROSS);

      await expect(
        systemPrisma.route.create({ data: { companyId: companyAId, agentId: userBId, weekday: 2, name: 'x' } }),
      ).rejects.toThrow(CROSS);
      await expect(
        systemPrisma.routeRun.create({ data: { companyId: companyBId, routeId: routeAId, date: new Date('2026-08-09') } }),
      ).rejects.toThrow(CROSS);
    });
  });

  // 20261013200000_sync_change_seq_tombstones: global changeSeq cursor on the
  // synced tables + trigger-written SyncTombstone (RLS + FORCE).
  describe('F4 sync changeSeq and SyncTombstone', () => {
    const createdProductIds: string[] = [];
    const newProduct = async (sku: string) => {
      const p = await withTenant(companyAId, (tx) =>
        tx.product.create({ data: { companyId: companyAId, sku: `${sku}-${Date.now()}`, name: sku, baseUnit: 'dona' } }),
      );
      createdProductIds.push(p.id);
      return p;
    };
    const tombstonesFor = (companyId: string, entityId: string) =>
      withTenant(companyId, (tx) => tx.syncTombstone.findMany({ where: { entityId }, orderBy: { changeSeq: 'asc' } }));

    afterAll(async () => {
      await systemPrisma.priceListItem.deleteMany({ where: { productId: { in: createdProductIds } } });
      await systemPrisma.stockLevel.deleteMany({ where: { productId: { in: createdProductIds } } });
      await systemPrisma.productPackaging.deleteMany({ where: { productId: { in: createdProductIds } } });
      await systemPrisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    });

    it('changeSeq is stamped on insert, increases on every update and ignores a writer-supplied value', async () => {
      const p = await newProduct('SEQ');
      const before = p.changeSeq;
      const updated = await withTenant(companyAId, (tx) =>
        tx.product.update({ where: { id: p.id }, data: { name: 'SEQ renamed', changeSeq: 1n } }),
      );
      expect(updated.changeSeq).toBeGreaterThan(before);
      const pkg = await withTenant(companyAId, (tx) =>
        tx.productPackaging.create({ data: { productId: p.id, name: 'blok', qtyInBaseUnit: 10, changeSeq: 1n } }),
      );
      expect(pkg.changeSeq).toBeGreaterThan(updated.changeSeq);
      const pkg2 = await withTenant(companyAId, (tx) =>
        tx.productPackaging.update({ where: { id: pkg.id }, data: { qtyInBaseUnit: 12 } }),
      );
      expect(pkg2.changeSeq).toBeGreaterThan(pkg.changeSeq);
    });

    it('hard DELETE writes a tombstone (direct and parent-resolved companyId, composite natural key)', async () => {
      const p = await newProduct('TOMB');
      const [pkg, item, stock] = await withTenant(companyAId, async (tx) => [
        await tx.productPackaging.create({ data: { productId: p.id, name: 'quti', qtyInBaseUnit: 20 } }),
        await tx.priceListItem.create({ data: { priceListId: priceListAId, productId: p.id, price: 1000 } }),
        await tx.stockLevel.create({ data: { productId: p.id, warehouseId: warehouseAId } }),
      ] as const);
      await withTenant(companyAId, async (tx) => {
        await tx.productPackaging.delete({ where: { id: pkg.id } });
        await tx.priceListItem.delete({ where: { id: item.id } });
        await tx.stockLevel.delete({ where: { productId_warehouseId: { productId: p.id, warehouseId: warehouseAId } } });
        await tx.product.delete({ where: { id: p.id } });
      });

      const [pkgT] = await tombstonesFor(companyAId, pkg.id);
      expect(pkgT).toMatchObject({ companyId: companyAId, entity: 'ProductPackaging', entityKey: null });
      expect(pkgT!.changeSeq).toBeGreaterThan(pkg.changeSeq);
      const [itemT] = await tombstonesFor(companyAId, item.id);
      expect(itemT).toMatchObject({
        companyId: companyAId,
        entity: 'PriceListItem',
        entityKey: { priceListId: priceListAId, productId: p.id },
      });
      const [stockT] = await tombstonesFor(companyAId, `${p.id}:${warehouseAId}`);
      expect(stockT).toMatchObject({
        companyId: companyAId,
        entity: 'StockLevel',
        entityKey: { productId: p.id, warehouseId: warehouseAId },
      });
      expect(stockT!.changeSeq).toBeGreaterThan(stock.changeSeq);
      const [productT] = await tombstonesFor(companyAId, p.id);
      expect(productT).toMatchObject({ companyId: companyAId, entity: 'Product' });
    });

    it('soft delete / deactivation writes a tombstone; reactivation bumps the row above it', async () => {
      const p = await newProduct('DEACT');
      await withTenant(companyAId, (tx) => tx.product.update({ where: { id: p.id }, data: { name: 'no-op for tombstones' } }));
      expect(await tombstonesFor(companyAId, p.id)).toHaveLength(0);

      await withTenant(companyAId, (tx) => tx.product.update({ where: { id: p.id }, data: { isActive: false } }));
      const [t1] = await tombstonesFor(companyAId, p.id);
      expect(t1).toMatchObject({ entity: 'Product', companyId: companyAId });

      const reactivated = await withTenant(companyAId, (tx) =>
        tx.product.update({ where: { id: p.id }, data: { isActive: true } }),
      );
      expect(reactivated.changeSeq).toBeGreaterThan(t1!.changeSeq);

      await withTenant(companyAId, (tx) => tx.customer.update({ where: { id: customerAId }, data: { deletedAt: new Date() } }));
      await withTenant(companyAId, (tx) => tx.customer.update({ where: { id: customerAId }, data: { deletedAt: null } }));
      const customerT = await tombstonesFor(companyAId, customerAId);
      expect(customerT).toHaveLength(1);
      expect(customerT[0]).toMatchObject({ entity: 'Customer', companyId: companyAId });
    });

    it('reactivating a Product re-stamps its packagings/prices/stock above the tombstone (deactivate is unchanged)', async () => {
      const p = await newProduct('REACT');
      const [pkg, item, stock] = await withTenant(companyAId, async (tx) => [
        await tx.productPackaging.create({ data: { productId: p.id, name: 'blok', qtyInBaseUnit: 10 } }),
        await tx.priceListItem.create({ data: { priceListId: priceListAId, productId: p.id, price: 1000 } }),
        await tx.stockLevel.create({ data: { productId: p.id, warehouseId: warehouseAId } }),
      ] as const);
      const children = () =>
        withTenant(companyAId, async (tx) => [
          (await tx.productPackaging.findUniqueOrThrow({ where: { id: pkg.id } })).changeSeq,
          (await tx.priceListItem.findUniqueOrThrow({ where: { id: item.id } })).changeSeq,
          (await tx.stockLevel.findUniqueOrThrow({
            where: { productId_warehouseId: { productId: p.id, warehouseId: warehouseAId } },
          })).changeSeq,
        ]);

      // Deactivation: tombstone as before, children untouched.
      await withTenant(companyAId, (tx) => tx.product.update({ where: { id: p.id }, data: { isActive: false } }));
      const [t1] = await tombstonesFor(companyAId, p.id);
      expect(t1).toMatchObject({ entity: 'Product', companyId: companyAId });
      expect(await children()).toEqual([pkg.changeSeq, item.changeSeq, stock.changeSeq]);

      const reactivated = await withTenant(companyAId, (tx) =>
        tx.product.update({ where: { id: p.id }, data: { isActive: true } }),
      );
      const after = await children();
      for (const [i, seq] of [pkg.changeSeq, item.changeSeq, stock.changeSeq].entries()) {
        expect(after[i]).toBeGreaterThan(seq);
        expect(after[i]).toBeGreaterThan(t1!.changeSeq);
      }
      expect(reactivated.changeSeq).toBeGreaterThan(t1!.changeSeq);
      expect(await tombstonesFor(companyAId, p.id)).toHaveLength(1);

      // Soft delete -> undelete also counts; a plain update does not touch children.
      await withTenant(companyAId, (tx) => tx.product.update({ where: { id: p.id }, data: { deletedAt: new Date() } }));
      const beforeUndelete = await children();
      await withTenant(companyAId, (tx) => tx.product.update({ where: { id: p.id }, data: { deletedAt: null } }));
      const afterUndelete = await children();
      afterUndelete.forEach((seq, i) => expect(seq).toBeGreaterThan(beforeUndelete[i]!));
      await withTenant(companyAId, (tx) => tx.product.update({ where: { id: p.id }, data: { name: 'renamed' } }));
      expect(await children()).toEqual(afterUndelete);
    });

    it('reactivating a Customer re-stamps its live outlets only, never another tenant’s', async () => {
      const outletSeq = (companyId: string, id: string) =>
        withTenant(companyId, async (tx) => (await tx.outlet.findUniqueOrThrow({ where: { id } })).changeSeq);
      const a0 = await outletSeq(companyAId, outletAId);
      const b0 = await outletSeq(companyBId, outletBId);

      await withTenant(companyAId, (tx) => tx.customer.update({ where: { id: customerAId }, data: { isActive: false } }));
      const [t] = (await tombstonesFor(companyAId, customerAId)).slice(-1);
      expect(t).toMatchObject({ entity: 'Customer', companyId: companyAId });
      expect(await outletSeq(companyAId, outletAId)).toBe(a0);

      await withTenant(companyAId, (tx) => tx.customer.update({ where: { id: customerAId }, data: { isActive: true } }));
      const a1 = await outletSeq(companyAId, outletAId);
      expect(a1).toBeGreaterThan(a0);
      expect(a1).toBeGreaterThan(t!.changeSeq);
      expect(await outletSeq(companyBId, outletBId)).toBe(b0);
    });

    it('SyncTombstone is scoped per tenant and fails closed without a tenant context', async () => {
      const p = await newProduct('RLS');
      await withTenant(companyAId, (tx) => tx.product.delete({ where: { id: p.id } }));
      expect(await tombstonesFor(companyAId, p.id)).toHaveLength(1);
      expect(await tombstonesFor(companyBId, p.id)).toHaveLength(0);
      // No tenant context: zero rows or a ''::uuid cast error — both fail
      // closed (see 'fails closed (never leaks)…' above).
      try {
        expect(await prisma.syncTombstone.findMany({ where: { entityId: p.id } })).toHaveLength(0);
      } catch (err) {
        expect(String(err)).toMatch(/uuid/i);
      }

      const touched = await withTenant(companyBId, (tx) =>
        tx.syncTombstone.deleteMany({ where: { entityId: p.id } }),
      );
      expect(touched.count).toBe(0);
      await expect(
        withTenant(companyBId, (tx) =>
          tx.syncTombstone.create({ data: { companyId: companyAId, entity: 'Product', entityId: p.id } }),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });
  describe('F5 ExportJob / ImportJob tracking columns and guards', () => {
    const CHECK = /check constraint|violates/i;
    const CROSS = /cross-tenant reference/i;
    const UNIQUE = /Unique constraint|unique/i;
    const HASH = 'a'.repeat(64);
    type ExportOver = { format?: 'XML' | 'EXCEL' | 'CSV'; requestedBy?: string; periodFrom?: Date; periodTo?: Date };
    const exportData = (companyId: string, over: ExportOver = {}) => ({
      companyId,
      type: '1c',
      format: 'XML' as const,
      periodFrom: new Date('2031-01-01T00:00:00Z'),
      periodTo: new Date('2031-01-31T23:59:59Z'),
      ...over,
    });

    afterAll(async () => {
      await systemPrisma.importJob.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    });

    it('ExportJob tracking columns default safely, are CHECKed, and stay tenant-scoped', async () => {
      const job = await withTenant(companyAId, (tx) =>
        tx.exportJob.create({ data: exportData(companyAId, { format: 'EXCEL', requestedBy: courierAId }) }),
      );
      expect(job.attemptCount).toBe(0);
      expect(job.fileHash).toBeNull();
      expect(job.recordCount).toBeNull();
      expect(job.mappingVersion).toBeNull();

      const done = await withTenant(companyAId, (tx) =>
        tx.exportJob.update({
          where: { id: job.id },
          data: { status: 'PROCESSING', fileHash: HASH, recordCount: 0, mappingVersion: 1, attemptCount: 1 },
        }),
      );
      expect(done.fileHash).toBe(HASH);

      for (const data of [
        { fileHash: 'A'.repeat(64) },
        { fileHash: 'abc' },
        { recordCount: -1 },
        { mappingVersion: 0 },
        { attemptCount: -1 },
      ]) {
        await expect(
          withTenant(companyAId, (tx) => tx.exportJob.update({ where: { id: job.id }, data })),
        ).rejects.toThrow(CHECK);
      }

      expect(await withTenant(companyBId, (tx) => tx.exportJob.findMany({ where: { id: job.id } }))).toHaveLength(0);
      const touched = await withTenant(companyBId, (tx) =>
        tx.exportJob.updateMany({ where: { id: job.id }, data: { attemptCount: 9 } }),
      );
      expect(touched.count).toBe(0);
    });

    it('ExportJob.requestedBy cannot point at another tenant’s user', async () => {
      await expect(
        withTenant(companyAId, (tx) =>
          tx.exportJob.create({
            data: exportData(companyAId, { periodFrom: new Date('2031-03-01T00:00:00Z'), requestedBy: userBId }),
          }),
        ),
      ).rejects.toThrow(CROSS);
    });

    it('at most one active (QUEUED/PROCESSING) export per company+type+format+period; GENERATED/FAILED never block', async () => {
      const key = { periodFrom: new Date('2031-02-01T00:00:00Z'), periodTo: new Date('2031-02-28T23:59:59Z') };
      const first = await withTenant(companyAId, (tx) => tx.exportJob.create({ data: exportData(companyAId, key) }));

      await expect(
        withTenant(companyAId, (tx) => tx.exportJob.create({ data: exportData(companyAId, key) })),
      ).rejects.toThrow(UNIQUE);
      await withTenant(companyAId, (tx) => tx.exportJob.update({ where: { id: first.id }, data: { status: 'PROCESSING' } }));
      await expect(
        withTenant(companyAId, (tx) => tx.exportJob.create({ data: exportData(companyAId, key) })),
      ).rejects.toThrow(UNIQUE);

      // Other format and other tenant are independent keys.
      await withTenant(companyAId, (tx) => tx.exportJob.create({ data: exportData(companyAId, { ...key, format: 'EXCEL' }) }));
      await withTenant(companyBId, (tx) => tx.exportJob.create({ data: exportData(companyBId, key) }));

      // Re-export allowed once the active one finishes (GENERATED or FAILED).
      await withTenant(companyAId, (tx) =>
        tx.exportJob.update({
          where: { id: first.id },
          data: { status: 'GENERATED', fileHash: HASH, storageKey: 'exports/1c/a/f.xml', recordCount: 0 },
        }),
      );
      const second = await withTenant(companyAId, (tx) => tx.exportJob.create({ data: exportData(companyAId, key) }));
      await withTenant(companyAId, (tx) => tx.exportJob.update({ where: { id: second.id }, data: { status: 'PROCESSING' } }));
      await withTenant(companyAId, (tx) => tx.exportJob.update({ where: { id: second.id }, data: { status: 'FAILED' } }));
      await withTenant(companyAId, (tx) => tx.exportJob.create({ data: exportData(companyAId, key) }));
    });

    it('ImportJob.createdBy is same-tenant only, progress is 0..100, rows stay tenant-scoped', async () => {
      const base = { companyId: companyAId, type: 'customers', status: 'PENDING', fileUrl: 'import/f5-test.xlsx' };
      const legacy = await withTenant(companyAId, (tx) => tx.importJob.create({ data: base }));
      expect(legacy.createdBy).toBeNull();
      expect(legacy.progress).toBeNull();

      const job = await withTenant(companyAId, (tx) =>
        tx.importJob.create({ data: { ...base, createdBy: courierAId, progress: 0 } }),
      );
      await withTenant(companyAId, (tx) => tx.importJob.update({ where: { id: job.id }, data: { progress: 100 } }));

      await expect(
        withTenant(companyAId, (tx) => tx.importJob.create({ data: { ...base, createdBy: userBId } })),
      ).rejects.toThrow(CROSS);
      await expect(
        withTenant(companyAId, (tx) => tx.importJob.update({ where: { id: job.id }, data: { createdBy: userBId } })),
      ).rejects.toThrow(CROSS);
      for (const progress of [-1, 101]) {
        await expect(
          withTenant(companyAId, (tx) => tx.importJob.update({ where: { id: job.id }, data: { progress } })),
        ).rejects.toThrow(CHECK);
      }

      const listed = await withTenant(companyAId, (tx) =>
        tx.importJob.findMany({ where: { companyId: companyAId }, orderBy: { createdAt: 'desc' } }),
      );
      expect(new Set(listed.map((j) => j.id))).toEqual(new Set([legacy.id, job.id]));
      expect(await withTenant(companyBId, (tx) => tx.importJob.findMany())).toHaveLength(0);
      const touched = await withTenant(companyBId, (tx) =>
        tx.importJob.updateMany({ where: { id: job.id }, data: { progress: 50 } }),
      );
      expect(touched.count).toBe(0);
    });
  });
  describe('F5.3 ExportJob lifecycle + accountant ACK (ADR-030)', () => {
    const CHECK = /check constraint|violates/i;
    const CROSS = /cross-tenant reference/i;
    const TRANSITION = /transition .* is not allowed/i;
    const HASH = 'b'.repeat(64);
    const phone = () => `+99894${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    let accountantAId: string;
    let accountantBId: string;
    let seq = 0;

    // Each job gets its own period so the active-period unique index never interferes.
    const newQueued = (companyId: string) => {
      const day = new Date(Date.UTC(2032, 0, 1 + ++seq));
      return withTenant(companyId, (tx) =>
        tx.exportJob.create({ data: { companyId, type: '1c', format: 'EXCEL', periodFrom: day, periodTo: day } }),
      );
    };
    const setStatus = (companyId: string, id: string, data: Record<string, unknown>) =>
      withTenant(companyId, (tx) => tx.exportJob.update({ where: { id }, data }));
    const artifact = { fileHash: HASH, storageKey: 'exports/1c/a/x.xlsx', recordCount: 3, fileName: 'x.xlsx', fileSize: 10, generatedAt: new Date() };
    const newGenerated = async (companyId = companyAId) => {
      const job = await newQueued(companyId);
      await setStatus(companyId, job.id, { status: 'PROCESSING' });
      return setStatus(companyId, job.id, { status: 'GENERATED', ...artifact });
    };
    const ack = (byId: string, over: Record<string, unknown> = {}) => ({
      status: 'ACCOUNTING_ACCEPTED',
      acknowledgedBy: byId,
      acknowledgedAt: new Date(),
      ackChecksum: HASH,
      ...over,
    });

    beforeAll(async () => {
      const mk = (companyId: string, firstName: string) =>
        systemPrisma.user.create({ data: { companyId, firstName, lastName: 'ACK', phone: phone() } });
      accountantAId = (await mk(companyAId, 'Buxgalter')).id;
      accountantBId = (await mk(companyBId, 'BuxgalterB')).id;
    });

    it('legacy backfill maps PENDING->QUEUED, DONE->GENERATED (PROCESSING/FAILED kept); legacy literals are rejected', async () => {
      const rows = await prisma.$queryRaw<{ v: string; s: string | null }[]>`
        SELECT v, velto_export_job_status_from_legacy(v)::text AS s
        FROM unnest(ARRAY['PENDING', 'PROCESSING', 'DONE', 'FAILED', 'BOGUS']) AS v`;
      expect(Object.fromEntries(rows.map((r) => [r.v, r.s]))).toEqual({
        PENDING: 'QUEUED',
        PROCESSING: 'PROCESSING',
        DONE: 'GENERATED',
        FAILED: 'FAILED',
        BOGUS: null,
      });
      const formats = await prisma.$queryRaw<{ v: string; f: string | null }[]>`
        SELECT v, velto_export_format_from_legacy(v)::text AS f FROM unnest(ARRAY['XML', 'EXCEL', 'CSV', 'PDF']) AS v`;
      expect(Object.fromEntries(formats.map((r) => [r.v, r.f]))).toEqual({ XML: 'XML', EXCEL: 'EXCEL', CSV: 'CSV', PDF: null });

      const job = await newQueued(companyAId);
      for (const legacy of ['PENDING', 'DONE']) {
        await expect(
          withTenant(companyAId, (tx) => tx.$executeRawUnsafe(`UPDATE "ExportJob" SET "status" = '${legacy}' WHERE "id" = '${job.id}'`)),
        ).rejects.toThrow(/invalid input value for enum/i);
      }
    });

    it('insert only as QUEUED and without an artifact', async () => {
      const day = new Date(Date.UTC(2032, 6, 1));
      const base = { companyId: companyAId, type: '1c', format: 'EXCEL' as const, periodFrom: day, periodTo: day };
      for (const data of [{ status: 'GENERATED' as const, ...artifact }, { status: 'PROCESSING' as const }, { fileHash: HASH }]) {
        await expect(withTenant(companyAId, (tx) => tx.exportJob.create({ data: { ...base, ...data } }))).rejects.toThrow(
          /must be inserted/i,
        );
      }
    });

    it('rejects illegal transitions; FAILED / ACCOUNTING_ACCEPTED / FAILED_REVIEW are terminal', async () => {
      const queued = await newQueued(companyAId);
      for (const status of ['GENERATED', 'FAILED', 'ACCOUNTING_ACCEPTED'] as const) {
        await expect(setStatus(companyAId, queued.id, { status })).rejects.toThrow(TRANSITION);
      }
      await setStatus(companyAId, queued.id, { status: 'PROCESSING' });
      await setStatus(companyAId, queued.id, { status: 'QUEUED' }); // retry
      await setStatus(companyAId, queued.id, { status: 'PROCESSING' });
      // GENERATED without the artifact fails the row-shape CHECK.
      await expect(setStatus(companyAId, queued.id, { status: 'GENERATED' })).rejects.toThrow(CHECK);
      await setStatus(companyAId, queued.id, { status: 'FAILED' });
      await expect(setStatus(companyAId, queued.id, { status: 'PROCESSING' })).rejects.toThrow(TRANSITION);

      const generated = await newGenerated();
      await expect(setStatus(companyAId, generated.id, { status: 'QUEUED' })).rejects.toThrow(TRANSITION);
      await setStatus(companyAId, generated.id, ack(accountantAId));
      await expect(
        setStatus(companyAId, generated.id, { status: 'FAILED_REVIEW', ackNote: 'qayta' }),
      ).rejects.toThrow(TRANSITION);
    });

    it('ACK: checksum must equal fileHash, actor+time required, FAILED_REVIEW needs a note of >= 3 chars', async () => {
      const job = await newGenerated();
      for (const data of [
        ack(accountantAId, { ackChecksum: 'c'.repeat(64) }),
        ack(accountantAId, { ackChecksum: null }),
        ack(accountantAId, { acknowledgedBy: null }),
        ack(accountantAId, { acknowledgedAt: null }),
        ack(accountantAId, { status: 'FAILED_REVIEW' }),
        ack(accountantAId, { status: 'FAILED_REVIEW', ackNote: '  ab  ' }),
      ]) {
        await expect(setStatus(companyAId, job.id, data)).rejects.toThrow(CHECK);
      }
      await expect(setStatus(companyAId, job.id, ack(accountantAId, { ackNote: 'x'.repeat(1001) }))).rejects.toThrow(
        /too long|value too long/i,
      );
      // ACK columns outside an ACK status are rejected (write-once on the transition only).
      await expect(setStatus(companyAId, job.id, { ackNote: 'early' })).rejects.toThrow(/write-once|check constraint/i);

      const reviewed = await setStatus(companyAId, job.id, ack(accountantAId, { status: 'FAILED_REVIEW', ackNote: 'Summalar mos emas' }));
      expect(reviewed.status).toBe('FAILED_REVIEW');
      await expect(setStatus(companyAId, job.id, { ackNote: 'boshqa izoh' })).rejects.toThrow(/write-once/i);
      await expect(setStatus(companyAId, job.id, { acknowledgedBy: null })).rejects.toThrow(/write-once/i);
    });

    it('from GENERATED on, artifact/period/format are immutable; DELETE/TRUNCATE rejected even for velto_system', async () => {
      const job = await newGenerated();
      for (const data of [
        { storageKey: 'exports/1c/a/other.xlsx' },
        { fileHash: 'd'.repeat(64) },
        { recordCount: 4 },
        { periodTo: new Date(Date.UTC(2033, 0, 1)) },
        { format: 'CSV' },
      ]) {
        await expect(setStatus(companyAId, job.id, data)).rejects.toThrow(/immutable/i);
      }
      await expect(withTenant(companyAId, (tx) => tx.exportJob.delete({ where: { id: job.id } }))).rejects.toThrow(/append-only/i);
      await expect(systemPrisma.exportJob.delete({ where: { id: job.id } })).rejects.toThrow(/append-only/i);
      await expect(systemPrisma.$executeRawUnsafe('TRUNCATE "ExportJob"')).rejects.toThrow(TRUNCATE_REJECTED);
    });

    it('tenant B cannot see or ACK tenant A’s export; ACK by another tenant’s user is rejected', async () => {
      const job = await newGenerated();
      const touched = await withTenant(companyBId, (tx) =>
        tx.exportJob.updateMany({ where: { id: job.id }, data: ack(accountantBId) as never }),
      );
      expect(touched.count).toBe(0);
      expect(await withTenant(companyBId, (tx) => tx.exportJob.findMany({ where: { id: job.id } }))).toHaveLength(0);
      await expect(setStatus(companyAId, job.id, ack(accountantBId))).rejects.toThrow(CROSS);

      const still = await withTenant(companyAId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: job.id } }));
      expect(still.status).toBe('GENERATED');
      expect(still.acknowledgedBy).toBeNull();
      const accepted = await setStatus(companyAId, job.id, ack(accountantAId));
      expect(accepted.status).toBe('ACCOUNTING_ACCEPTED');
    });
  });
  describe('F8.1 payment handover (ADR-029): PENDING_HANDOVER -> POSTED / REJECTED', () => {
    const phone = () => `+99893${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    let agentId: string;
    let cashierId: string;
    let otherCashierId: string;
    let cashierBId: string;
    let customerId: string;
    let invoiceId: string;
    let openSessionId: string;
    let closedSessionId: string;
    let otherSessionId: string;
    let sessionBId: string;
    let seq = 0;

    const newPending = (amount = '50.00') =>
      withTenant(companyAId, (tx) =>
        tx.payment.create({
          data: {
            companyId: companyAId,
            number: `PAY-HO-${Date.now()}-${++seq}`,
            customerId,
            amount,
            method: 'CASH',
            status: 'PENDING_HANDOVER',
            collectedBy: agentId,
          },
        }),
      );
    const accept = (id: string, extra: Record<string, unknown> = {}) =>
      withTenant(companyAId, (tx) =>
        tx.payment.update({
          where: { id },
          data: {
            status: 'POSTED',
            handoverActorId: cashierId,
            handoverAt: new Date(),
            handoverCashSessionId: openSessionId,
            ...extra,
          },
        }),
      );

    beforeAll(async () => {
      const mk = (companyId: string, firstName: string) =>
        systemPrisma.user.create({ data: { companyId, firstName, lastName: 'HO', phone: phone() } });
      agentId = (await mk(companyAId, 'Agent')).id;
      cashierId = (await mk(companyAId, 'Kassir')).id;
      otherCashierId = (await mk(companyAId, 'Kassir2')).id;
      cashierBId = (await mk(companyBId, 'KassirB')).id;
      await withTenant(companyAId, async (tx) => {
        customerId = (await tx.customer.create({ data: { companyId: companyAId, code: 'A-HO', name: 'Handover A' } })).id;
        invoiceId = (
          await tx.invoice.create({ data: { companyId: companyAId, number: 'INV-HO-1', customerId, total: '500.00' } })
        ).id;
        closedSessionId = (
          await tx.cashSession.create({
            data: { companyId: companyAId, userId: cashierId, openAmount: '0.00', closedAt: new Date(), closeAmount: '0.00' },
          })
        ).id;
        openSessionId = (await tx.cashSession.create({ data: { companyId: companyAId, userId: cashierId, openAmount: '0.00' } })).id;
        otherSessionId = (
          await tx.cashSession.create({ data: { companyId: companyAId, userId: otherCashierId, openAmount: '0.00' } })
        ).id;
      });
      sessionBId = (
        await withTenant(companyBId, (tx) =>
          tx.cashSession.create({ data: { companyId: companyBId, userId: cashierBId, openAmount: '0.00' } }),
        )
      ).id;
    });

    it('insert: only PENDING_HANDOVER (agent-collected) or POSTED, never pre-resolved', async () => {
      const base = { companyId: companyAId, customerId, amount: '1.00', method: 'CASH' as const, collectedBy: agentId };
      for (const status of ['REJECTED', 'REVERSED'] as const) {
        await expect(
          withTenant(companyAId, (tx) => tx.payment.create({ data: { ...base, number: `PAY-HO-BAD-${status}`, status } })),
        ).rejects.toThrow(/inserted as PENDING_HANDOVER or POSTED/);
      }
      await expect(
        withTenant(companyAId, (tx) =>
          tx.payment.create({
            data: { ...base, number: 'PAY-HO-BAD-PRE', handoverActorId: cashierId, handoverAt: new Date(), handoverCashSessionId: openSessionId },
          }),
        ),
      ).rejects.toThrow(/handover columns/);
      await expect(
        withTenant(companyAId, (tx) =>
          tx.payment.create({ data: { ...base, number: 'PAY-HO-BAD-NOAGENT', collectedBy: null, status: 'PENDING_HANDOVER' } }),
        ),
      ).rejects.toThrow();
    });

    it('agent CARD/TRANSFER payments are PENDING_HANDOVER too, and can be accepted', async () => {
      for (const method of ['CARD', 'TRANSFER'] as const) {
        const p = await withTenant(companyAId, (tx) =>
          tx.payment.create({
            data: {
              companyId: companyAId,
              number: `PAY-HO-${method}-${Date.now()}-${++seq}`,
              customerId,
              amount: '10.00',
              method,
              status: 'PENDING_HANDOVER',
              collectedBy: agentId,
            },
          }),
        );
        expect(p.status).toBe('PENDING_HANDOVER');
        expect((await accept(p.id)).status).toBe('POSTED');
      }
    });

    it('self-resolve is forbidden at DB level: collector cannot accept or reject own handover', async () => {
      const agentSessionId = (
        await withTenant(companyAId, (tx) => tx.cashSession.create({ data: { companyId: companyAId, userId: agentId, openAmount: '0.00' } }))
      ).id;
      const p = await newPending();
      await expect(accept(p.id, { handoverActorId: agentId, handoverCashSessionId: agentSessionId })).rejects.toThrow(
        /may not resolve their own handover/,
      );
      await expect(
        withTenant(companyAId, (tx) =>
          tx.payment.update({
            where: { id: p.id },
            data: { status: 'REJECTED', handoverActorId: agentId, handoverAt: new Date(), handoverRejectReason: 'x' },
          }),
        ),
      ).rejects.toThrow(/may not resolve their own handover/);
      const still = await withTenant(companyAId, (tx) => tx.payment.findUniqueOrThrow({ where: { id: p.id } }));
      expect(still.status).toBe('PENDING_HANDOVER');
    });

    it('PENDING_HANDOVER cannot be allocated (no FIFO in transit)', async () => {
      const p = await newPending();
      await expect(
        withTenant(companyAId, (tx) => tx.paymentAllocation.create({ data: { paymentId: p.id, invoiceId, amount: '50.00' } })),
      ).rejects.toThrow(/requires a POSTED payment/);
    });

    it('accept needs the actor\'s own OPEN, same-company session and full metadata', async () => {
      const p = await newPending();
      await expect(accept(p.id, { handoverCashSessionId: closedSessionId })).rejects.toThrow(/is closed/);
      await expect(accept(p.id, { handoverCashSessionId: otherSessionId })).rejects.toThrow(/does not belong/);
      await expect(accept(p.id, { handoverCashSessionId: sessionBId })).rejects.toThrow(/cross-tenant|not found/);
      await expect(accept(p.id, { handoverActorId: cashierBId })).rejects.toThrow(/cross-tenant|does not belong/);
      await expect(accept(p.id, { handoverAt: null })).rejects.toThrow();
      await expect(accept(p.id, { handoverRejectReason: 'x' })).rejects.toThrow();
      // Immutable columns cannot ride along with the transition.
      await expect(accept(p.id, { amount: '49.00' })).rejects.toThrow(/append-only/);
      await expect(accept(p.id, { customerId: customerBId })).rejects.toThrow();
      const still = await withTenant(companyAId, (tx) => tx.payment.findUniqueOrThrow({ where: { id: p.id } }));
      expect(still.status).toBe('PENDING_HANDOVER');
    });

    it('accept -> POSTED once; then allocatable, handover columns frozen, no way back', async () => {
      const p = await newPending();
      const posted = await accept(p.id);
      expect(posted.status).toBe('POSTED');
      expect(posted.handoverCashSessionId).toBe(openSessionId);
      expect(posted.amount.toString()).toBe('50');

      await withTenant(companyAId, (tx) => tx.paymentAllocation.create({ data: { paymentId: p.id, invoiceId, amount: '50.00' } }));

      await expect(
        withTenant(companyAId, (tx) => tx.payment.update({ where: { id: p.id }, data: { handoverAt: new Date(0) } })),
      ).rejects.toThrow(/not allowed/);
      await expect(
        withTenant(companyAId, (tx) =>
          tx.payment.update({ where: { id: p.id }, data: { status: 'PENDING_HANDOVER', handoverActorId: null, handoverAt: null, handoverCashSessionId: null } }),
        ),
      ).rejects.toThrow(/not allowed/);

      // An accepted handover is still reversible (F2.1), without touching handover columns.
      await expect(
        withTenant(companyAId, async (tx) => {
          await tx.paymentReversal.create({ data: { companyId: companyAId, reversesPaymentId: p.id, reason: 'test', actorId: cashierId } });
          await tx.payment.update({ where: { id: p.id }, data: { status: 'REVERSED', handoverActorId: otherCashierId } });
        }),
      ).rejects.toThrow(/reversal may not change handover columns/);
      const reversed = await withTenant(companyAId, async (tx) => {
        await tx.paymentReversal.create({ data: { companyId: companyAId, reversesPaymentId: p.id, reason: 'test', actorId: cashierId } });
        return tx.payment.update({ where: { id: p.id }, data: { status: 'REVERSED' } });
      });
      expect(reversed.status).toBe('REVERSED');
      expect(reversed.handoverActorId).toBe(cashierId);
    });

    it('reject -> REJECTED needs actor, time and a reason; it is terminal', async () => {
      const p = await newPending();
      const reject = (extra: Record<string, unknown>) =>
        withTenant(companyAId, (tx) =>
          tx.payment.update({
            where: { id: p.id },
            data: { status: 'REJECTED', handoverActorId: cashierId, handoverAt: new Date(), ...extra },
          }),
        );
      await expect(reject({ handoverRejectReason: '   ' })).rejects.toThrow();
      await expect(reject({ handoverRejectReason: null })).rejects.toThrow();
      await expect(reject({ handoverRejectReason: 'kam keldi', handoverCashSessionId: openSessionId })).rejects.toThrow();
      const rejected = await reject({ handoverRejectReason: 'kam keldi' });
      expect(rejected.status).toBe('REJECTED');

      await expect(accept(p.id, { handoverRejectReason: null })).rejects.toThrow(/not allowed/);
      await expect(
        withTenant(companyAId, (tx) => tx.paymentAllocation.create({ data: { paymentId: p.id, invoiceId, amount: '1.00' } })),
      ).rejects.toThrow(/requires a POSTED payment/);
    });

    it('RLS: another tenant can neither see nor resolve a pending handover; no context = zero rows', async () => {
      const p = await newPending();
      expect(await withTenant(companyBId, (tx) => tx.payment.findMany({ where: { id: p.id } }))).toHaveLength(0);
      const touched = await withTenant(companyBId, (tx) =>
        tx.payment.updateMany({
          where: { id: p.id },
          data: { status: 'POSTED', handoverActorId: cashierBId, handoverAt: new Date(), handoverCashSessionId: sessionBId },
        }),
      );
      expect(touched.count).toBe(0);
      try {
        expect(await prisma.payment.findMany({ where: { id: p.id } })).toHaveLength(0);
      } catch (err) {
        expect(String(err)).toMatch(/uuid/i);
      }
      const still = await withTenant(companyAId, (tx) => tx.payment.findUniqueOrThrow({ where: { id: p.id } }));
      expect(still.status).toBe('PENDING_HANDOVER');
    });
  });
});
