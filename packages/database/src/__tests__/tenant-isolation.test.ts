// SEC-001..005 / VELTO-TZ.md 6.10: "Har bir yangi jadval uchun izolyatsiya
// testi majburiy" — cross-tenant leak tests must run in CI and block merge.
// This exercises both isolation strategies used in the RLS migration:
// direct-companyId tables (Customer) and parent-subquery child tables
// (RolePermission, isolated via its Role's companyId), plus the fail-closed
// default and the AuditLog append-only trigger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma, withTenant } from '../client';

describe('tenant isolation (RLS)', () => {
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
  let supplierAId: string;
  let supplierBId: string;
  let supplierRouteAId: string;
  let supplierRouteBId: string;

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
      tx.exportJob.create({ data: { companyId: companyAId, type: '1c', format: 'XML', status: 'PENDING', ...period } }),
    );

    await withTenant(companyAId, (tx) =>
      tx.documentCounter.create({ data: { companyId: companyAId, docType: 'SO', year: 2026, lastNumber: 1 } }),
    );

    const recipient = await systemPrisma.user.create({
      data: { companyId: companyAId, firstName: 'Notify', lastName: 'Me', phone: '+998900000097' },
    });
    recipientId = recipient.id;
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

    // SupplierTelegramLink + Supplier pickup location
    // (20260809120000_supplier_telegram_link_and_pickup).
    const [supplierA, supplierB] = await Promise.all([
      withTenant(companyAId, (tx) =>
        tx.supplier.create({
          data: {
            companyId: companyAId,
            name: 'Supplier A',
            pickupAddress: 'Toshkent, Chilonzor 1',
            pickupLatitude: '41.2856000',
            pickupLongitude: '69.2034000',
          },
        }),
      ),
      withTenant(companyBId, (tx) => tx.supplier.create({ data: { companyId: companyBId, name: 'Supplier B' } })),
    ]);
    supplierAId = supplierA.id;
    supplierBId = supplierB.id;

    await withTenant(companyAId, (tx) =>
      tx.supplierTelegramLink.create({
        data: { companyId: companyAId, supplierId: supplierAId, telegramId: BigInt(Date.now()) + 1n },
      }),
    );

    // SupplierRoute + SupplierRouteStop (20260809140000_supplier_pickup_routes).
    // Both tenants get a route so the "each side sees only its own" assertions
    // below can't pass vacuously.
    const [supplierRouteA, supplierRouteB] = await Promise.all([
      withTenant(companyAId, (tx) =>
        tx.supplierRoute.create({
          data: { companyId: companyAId, supplierId: supplierAId, weekday: 2, name: 'Pickup Route A' },
        }),
      ),
      withTenant(companyBId, (tx) =>
        tx.supplierRoute.create({
          data: { companyId: companyBId, supplierId: supplierBId, weekday: 3, name: 'Pickup Route B' },
        }),
      ),
    ]);
    supplierRouteAId = supplierRouteA.id;
    supplierRouteBId = supplierRouteB.id;

    await withTenant(companyAId, (tx) =>
      tx.supplierRouteStop.create({
        data: {
          companyId: companyAId,
          routeId: supplierRouteAId,
          sequence: 1,
          pickupAddress: 'Toshkent, Chilonzor 1 (ombor)',
          latitude: '41.2856000',
          longitude: '69.2034000',
        },
      }),
    );

    await withTenant(companyAId, async (tx) => {
      const role = await tx.role.create({ data: { companyId: companyAId, code: 'ISO_TEST', name: 'Isolation Test Role' } });
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
    });
  });

  afterAll(async () => {
    // Company/Tenant are deliberately NOT deleted here: the AuditLog test
    // below creates a row that FK-restricts deletion of its Company, and the
    // log itself can never be deleted (append-only). That's the correct
    // behavior for immutable audit history (15.6, ≥3 year retention), so this
    // suite leaves a small, harmless test fixture behind rather than fighting
    // the constraint. CI runs against a throwaway database per run anyway.
    await systemPrisma.rolePermission.deleteMany({ where: { permissionId } });
    await systemPrisma.role.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.exportJob.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.documentCounter.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.notification.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.routeRun.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.routeStop.deleteMany({ where: { routeId: routeAId } });
    await systemPrisma.route.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.user.delete({ where: { id: recipientId } });
    const scopedCompanies = { companyId: { in: [companyAId, companyBId, companyCId] } };
    await systemPrisma.supplierTelegramLink.deleteMany({ where: scopedCompanies });
    // Stops before routes before suppliers — all three are FK RESTRICT.
    await systemPrisma.supplierRouteStop.deleteMany({ where: scopedCompanies });
    await systemPrisma.supplierRoute.deleteMany({ where: scopedCompanies });
    await systemPrisma.supplier.deleteMany({ where: scopedCompanies });
    await systemPrisma.salesOrder.deleteMany({ where: scopedCompanies });
    await systemPrisma.priceListItem.deleteMany({ where: { priceListId: priceListAId } });
    await systemPrisma.stockLevel.deleteMany({ where: { warehouseId: { in: [warehouseAId, warehouseBId] } } });
    await systemPrisma.productCategory.deleteMany({ where: scopedCompanies });
    await systemPrisma.product.deleteMany({ where: scopedCompanies });
    await systemPrisma.warehouse.deleteMany({ where: scopedCompanies });
    await systemPrisma.outlet.deleteMany({ where: scopedCompanies });
    await systemPrisma.customer.updateMany({ where: scopedCompanies, data: { priceListId: null } });
    await systemPrisma.priceList.deleteMany({ where: scopedCompanies });
    await systemPrisma.customer.deleteMany({ where: scopedCompanies });
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

  it('a direct-companyId table (RouteRun, 9.4 route finish) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.routeRun.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.routeRun.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a direct-companyId table (Route, 6.8 field) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.route.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.route.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  // 20260809120000_supplier_telegram_link_and_pickup. Supplier contacts are
  // external counterparties, so a leak here would hand one distributor its
  // competitor's supplier list *and* a live Telegram id to message.
  it('a direct-companyId table (SupplierTelegramLink, M09) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.supplierTelegramLink.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.supplierTelegramLink.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromA[0]?.supplierId).toBe(supplierAId);
    expect(seenFromB).toHaveLength(0);

    // Reading company A's supplier (and therefore its pickup coordinates) by
    // id from company B must return nothing, not just be filtered from a list.
    const probed = await withTenant(companyBId, (tx) => tx.supplier.findUnique({ where: { id: supplierAId } }));
    expect(probed).toBeNull();
  });

  it('rejects a SupplierTelegramLink pointing at another tenant’s supplier', async () => {
    await expect(
      systemPrisma.supplierTelegramLink.create({
        data: { companyId: companyAId, supplierId: supplierBId, telegramId: BigInt(Date.now()) + 2n },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    // No link row leaked into either company as a side effect.
    const inB = await withTenant(companyBId, (tx) => tx.supplierTelegramLink.findMany());
    expect(inB).toHaveLength(0);
  });

  it('rejects a PurchaseOrder pointing at another tenant’s supplier', async () => {
    await expect(
      systemPrisma.purchaseOrder.create({
        data: {
          companyId: companyAId,
          number: 'ISO-PO-XT-1',
          supplierId: supplierBId,
          warehouseId: warehouseAId,
        },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    // Selective, not "always throws": the all-company-A row is accepted.
    const ok = await withTenant(companyAId, (tx) =>
      tx.purchaseOrder.create({
        data: { companyId: companyAId, number: 'ISO-PO-XT-OK', supplierId: supplierAId, warehouseId: warehouseAId },
      }),
    );
    expect(ok.supplierId).toBe(supplierAId);
    await systemPrisma.purchaseOrder.delete({ where: { id: ok.id } });
  });

  it('SupplierTelegramLink.telegramId is unique per company, not globally', async () => {
    const telegramId = BigInt(Date.now()) + 3n;

    // A second supplier in company A: the per-supplier unique means the same
    // telegramId can't be re-linked to supplierA, so the collision under test
    // is specifically the companyId+telegramId one.
    const [supplierA2, supplierA3] = await Promise.all([
      withTenant(companyAId, (tx) => tx.supplier.create({ data: { companyId: companyAId, name: 'Supplier A2' } })),
      withTenant(companyAId, (tx) => tx.supplier.create({ data: { companyId: companyAId, name: 'Supplier A3' } })),
    ]);

    const links = await Promise.all([
      withTenant(companyAId, (tx) =>
        tx.supplierTelegramLink.create({
          data: { companyId: companyAId, supplierId: supplierA2.id, telegramId },
        }),
      ),
      withTenant(companyBId, (tx) =>
        tx.supplierTelegramLink.create({
          data: { companyId: companyBId, supplierId: supplierBId, telegramId },
        }),
      ),
    ]);
    expect(links).toHaveLength(2);

    // Still unique *within* a company — one Telegram account cannot be two
    // supplier contacts in the same tenant.
    await expect(
      withTenant(companyAId, (tx) =>
        tx.supplierTelegramLink.create({
          data: { companyId: companyAId, supplierId: supplierA3.id, telegramId },
        }),
      ),
    ).rejects.toThrow();

    await systemPrisma.supplierTelegramLink.deleteMany({ where: { id: { in: links.map((l) => l.id) } } });
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

  // 20260809140000_supplier_pickup_routes. A supplier pickup schedule is
  // competitively sensitive: it reveals who a rival buys from, how often, and
  // the exact coordinates of the collection point.
  it('a direct-companyId table (SupplierRoute, M09 pickups) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.supplierRoute.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.supplierRoute.findMany());

    expect(seenFromA.map((r) => r.id)).toEqual([supplierRouteAId]);
    expect(seenFromB.map((r) => r.id)).toEqual([supplierRouteBId]);

    // Direct-id probe from the wrong tenant must be indistinguishable from
    // "does not exist", not an authorization error.
    const probed = await withTenant(companyBId, (tx) => tx.supplierRoute.findUnique({ where: { id: supplierRouteAId } }));
    expect(probed).toBeNull();
  });

  it('a direct-companyId table (SupplierRouteStop) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.supplierRouteStop.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.supplierRouteStop.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromA[0]?.routeId).toBe(supplierRouteAId);
    expect(seenFromA[0]?.pickupAddress).toContain('Chilonzor');
    expect(seenFromB).toHaveLength(0);

    // Coordinates must not leak through the parent relation either.
    const viaParent = await withTenant(companyBId, (tx) =>
      tx.supplierRoute.findMany({ include: { stops: true } }),
    );
    expect(viaParent.flatMap((r) => r.stops)).toHaveLength(0);
  });

  it('supplier pickup routes are invisible outside withTenant (fail closed)', async () => {
    // Same caveat as the generic fail-closed test below: on a pooled
    // connection the custom GUC reverts to '' rather than NULL, so the
    // ::uuid cast in the policy may throw instead of matching zero rows.
    // Both outcomes are safe; asserting on which one occurs would only test
    // connection-pool timing.
    for (const read of [() => prisma.supplierRoute.findMany(), () => prisma.supplierRouteStop.findMany()]) {
      try {
        expect(await read()).toHaveLength(0);
      } catch (err) {
        expect(String(err)).toMatch(/uuid/i);
      }
    }
  });

  it('rejects a SupplierRoute pointing at another tenant’s supplier', async () => {
    await expect(
      systemPrisma.supplierRoute.create({
        data: { companyId: companyAId, supplierId: supplierBId, weekday: 4, name: 'Cross-tenant pickup' },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    const inB = await withTenant(companyBId, (tx) => tx.supplierRoute.findMany());
    expect(inB.map((r) => r.id)).toEqual([supplierRouteBId]);
  });

  it('rejects a SupplierRouteStop pointing at another tenant’s SupplierRoute', async () => {
    await expect(
      systemPrisma.supplierRouteStop.create({
        data: { companyId: companyAId, routeId: supplierRouteBId, sequence: 1, pickupAddress: 'leak' },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    const ok = await withTenant(companyAId, (tx) =>
      tx.supplierRouteStop.create({
        data: { companyId: companyAId, routeId: supplierRouteAId, sequence: 2, pickupAddress: 'Sergeli bozor' },
      }),
    );
    expect(ok.routeId).toBe(supplierRouteAId);
  });

  // Guards the "do not touch existing Route/RouteStop" constraint: the new
  // tables must not have become visible to the agent-route readers.
  it('SupplierRoute rows do not appear in the agent Route/RouteStop tables', async () => {
    const routes = await withTenant(companyAId, (tx) => tx.route.findMany());
    expect(routes.map((r) => r.id)).toEqual([routeAId]);
    expect(routes.every((r) => r.agentId !== null)).toBe(true);

    const stops = await withTenant(companyAId, (tx) => tx.routeStop.findMany());
    expect(stops.every((s) => s.routeId === routeAId)).toBe(true);
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
    ).rejects.toThrow(/append-only/i);

    // No cleanup: the row is append-only by design, even for the BYPASSRLS
    // role — this one test log entry is expected to remain in dev/test data.
  });
});
