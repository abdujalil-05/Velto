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
  let deliveryOrderAId: string;
  let deliveryRouteAId: string;
  let adminBId: string;
  let linkCodeAId: string;
  let linkCodeAValue: string;
  let linkCodeBId: string;
  let linkCodeBValue: string;

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

    // SupplierTelegramLinkCode (20260810150000_supplier_telegram_link_code):
    // the one-time `/start <code>` handshake that is the only thing that ever
    // creates the link row above. Both companies get one, so "each side sees
    // only its own" can't pass vacuously.
    const adminB = await systemPrisma.user.create({
      data: { companyId: companyBId, firstName: 'Admin', lastName: 'B', phone: '+998900000096' },
    });
    adminBId = adminB.id;

    const [linkCodeA, linkCodeB] = await Promise.all([
      withTenant(companyAId, (tx) =>
        tx.supplierTelegramLinkCode.create({
          data: {
            companyId: companyAId,
            supplierId: supplierAId,
            code: `ISO-TG-A-${stamp}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            createdById: recipientId,
          },
        }),
      ),
      withTenant(companyBId, (tx) =>
        tx.supplierTelegramLinkCode.create({
          data: {
            companyId: companyBId,
            supplierId: supplierBId,
            code: `ISO-TG-B-${stamp}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            createdById: adminB.id,
          },
        }),
      ),
    ]);
    linkCodeAId = linkCodeA.id;
    linkCodeAValue = linkCodeA.code;
    linkCodeBId = linkCodeB.id;
    linkCodeBValue = linkCodeB.code;

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

    // Deliverer ("yetkazib beruvchi") links on outbound work
    // (20260810120000_order_route_supplier_link + 20260810130000_route_agent_or_supplier).
    // Company A only, on purpose: the Route cases above assert company B owns
    // no route at all, and what needs proving here is that B cannot reach A's
    // — a mirrored B fixture would weaken those assertions without adding
    // coverage. `routeAId` stays agent-served so both arms of the XOR are
    // represented in the fixture set.
    const deliveryRouteA = await withTenant(companyAId, (tx) =>
      tx.route.create({
        data: { companyId: companyAId, supplierId: supplierAId, weekday: 5, name: 'Supplier-served Route A' },
      }),
    );
    deliveryRouteAId = deliveryRouteA.id;
    const deliveryOrderA = await withTenant(companyAId, (tx) =>
      tx.salesOrder.create({
        data: {
          companyId: companyAId,
          number: 'ISO-SUP-A',
          customerId: customerAId,
          outletId: outletAId,
          warehouseId: warehouseAId,
          supplierId: supplierAId,
        },
      }),
    );
    deliveryOrderAId = deliveryOrderA.id;

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
    const scopedCompanies = { companyId: { in: [companyAId, companyBId, companyCId] } };
    // Before the users: SupplierTelegramLinkCode.createdById is FK RESTRICT
    // (only supplierId cascades).
    await systemPrisma.supplierTelegramLinkCode.deleteMany({ where: scopedCompanies });
    await systemPrisma.user.delete({ where: { id: recipientId } });
    await systemPrisma.user.delete({ where: { id: adminBId } });
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

    // Both arms of the agent-XOR-supplier split (20260810130000) are company
    // A's; company B must see neither.
    expect(new Set(seenFromA.map((r) => r.id))).toEqual(new Set([routeAId, deliveryRouteAId]));
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

  // 20260810150000_supplier_telegram_link_code. This table holds a live secret
  // (`code`) that anyone who can read it can redeem into a Telegram link on
  // the owning tenant's supplier — so a read leak here is a write escalation,
  // not just a disclosure.
  it('a direct-companyId table (SupplierTelegramLinkCode, M09) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.supplierTelegramLinkCode.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.supplierTelegramLinkCode.findMany());

    expect(seenFromA.map((c) => c.id)).toEqual([linkCodeAId]);
    expect(seenFromB.map((c) => c.id)).toEqual([linkCodeBId]);

    // `code` is globally unique, so a findUnique by code is a legal query from
    // *any* tenant — RLS is the only thing standing between company B and
    // company A's redeemable secret. It must return nothing, not a row.
    const probedByCode = await withTenant(companyBId, (tx) =>
      tx.supplierTelegramLinkCode.findUnique({ where: { code: linkCodeAValue } }),
    );
    expect(probedByCode).toBeNull();

    const probedById = await withTenant(companyBId, (tx) =>
      tx.supplierTelegramLinkCode.findUnique({ where: { id: linkCodeAId } }),
    );
    expect(probedById).toBeNull();
  });

  it('cannot burn or hijack another tenant’s SupplierTelegramLinkCode', async () => {
    // Marking someone else's code used is a denial-of-service on their linking
    // flow; repointing it is worse. Both must be no-ops, not errors.
    const burned = await withTenant(companyBId, (tx) =>
      tx.supplierTelegramLinkCode.updateMany({ where: { code: linkCodeAValue }, data: { usedAt: new Date() } }),
    );
    expect(burned.count).toBe(0);

    const deleted = await withTenant(companyBId, (tx) =>
      tx.supplierTelegramLinkCode.deleteMany({ where: { code: linkCodeAValue } }),
    );
    expect(deleted.count).toBe(0);

    const stillPending = await systemPrisma.supplierTelegramLinkCode.findUnique({ where: { code: linkCodeAValue } });
    expect(stillPending?.usedAt).toBeNull();
  });

  it('rejects a SupplierTelegramLinkCode pointing at another tenant’s supplier or admin', async () => {
    const base = {
      companyId: companyAId,
      expiresAt: new Date(Date.now() + 3_600_000),
    };

    // Cross-tenant supplier. systemPrisma (BYPASSRLS) is used deliberately:
    // it's the role the webhook/provisioning paths run as, so it proves the
    // guard is the trigger and not merely RLS filtering the parent lookup.
    await expect(
      systemPrisma.supplierTelegramLinkCode.create({
        data: { ...base, supplierId: supplierBId, code: `ISO-TG-XT-1-${Date.now()}`, createdById: recipientId },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    // Cross-tenant createdById (the admin who generated the code).
    await expect(
      systemPrisma.supplierTelegramLinkCode.create({
        data: { ...base, supplierId: supplierAId, code: `ISO-TG-XT-2-${Date.now()}`, createdById: adminBId },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    // Selective, not "always throws": the all-company-A row is accepted.
    const ok = await withTenant(companyAId, (tx) =>
      tx.supplierTelegramLinkCode.create({
        data: { ...base, supplierId: supplierAId, code: `ISO-TG-XT-OK-${Date.now()}`, createdById: recipientId },
      }),
    );
    expect(ok.supplierId).toBe(supplierAId);
    expect(ok.usedAt).toBeNull();
    await systemPrisma.supplierTelegramLinkCode.delete({ where: { id: ok.id } });

    // Nothing leaked into company B as a side effect of the rejected writes.
    const inB = await withTenant(companyBId, (tx) => tx.supplierTelegramLinkCode.findMany());
    expect(inB.map((c) => c.id)).toEqual([linkCodeBId]);
  });

  it('SupplierTelegramLinkCode.code is globally unique so the webhook can resolve it with no tenant context', async () => {
    // The webhook sees only a chat id and `/start <code>` — there is no
    // companyId to scope by, exactly like the phone lookup at login. These two
    // assertions are the contract api-dev builds the redemption flow on.
    const resolved = await systemPrisma.supplierTelegramLinkCode.findUnique({ where: { code: linkCodeBValue } });
    expect(resolved?.companyId).toBe(companyBId);
    expect(resolved?.supplierId).toBe(supplierBId);

    // ...and the uniqueness that makes that lookup unambiguous spans tenants:
    // company A cannot mint a code that collides with company B's.
    await expect(
      withTenant(companyAId, (tx) =>
        tx.supplierTelegramLinkCode.create({
          data: {
            companyId: companyAId,
            supplierId: supplierAId,
            code: linkCodeBValue,
            expiresAt: new Date(Date.now() + 3_600_000),
            createdById: recipientId,
          },
        }),
      ),
    ).rejects.toThrow();
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

  // 20260810120000_order_route_supplier_link. The deliverer link is a new
  // column on two tables that were already RLS-protected, so this asserts the
  // existing `tenant_isolation` policy really does cover it (a policy is
  // per-table, not per-column) — including through the new Supplier
  // back-relations, which are a fresh join path into another tenant's rows.
  it('a SalesOrder/Route carrying a supplierId (deliverer) is invisible cross-tenant', async () => {
    const ordersFromA = await withTenant(companyAId, (tx) =>
      tx.salesOrder.findMany({ where: { supplierId: { not: null } } }),
    );
    expect(ordersFromA.map((o) => o.id)).toEqual([deliveryOrderAId]);
    expect(ordersFromA[0]?.supplierId).toBe(supplierAId);

    const ordersFromB = await withTenant(companyBId, (tx) =>
      tx.salesOrder.findMany({ where: { supplierId: { not: null } } }),
    );
    expect(ordersFromB).toHaveLength(0);

    // Filtering by the other tenant's supplier id must be indistinguishable
    // from "no such supplier" — otherwise the filter is an existence oracle.
    const probedOrders = await withTenant(companyBId, (tx) =>
      tx.salesOrder.findMany({ where: { supplierId: supplierAId } }),
    );
    expect(probedOrders).toHaveLength(0);
    const probedOrder = await withTenant(companyBId, (tx) =>
      tx.salesOrder.findUnique({ where: { id: deliveryOrderAId } }),
    );
    expect(probedOrder).toBeNull();

    const routeFromA = await withTenant(companyAId, (tx) =>
      tx.route.findUnique({ where: { id: deliveryRouteAId } }),
    );
    expect(routeFromA?.supplierId).toBe(supplierAId);
    expect(routeFromA?.agentId).toBeNull();
    const routesFromB = await withTenant(companyBId, (tx) =>
      tx.route.findMany({ where: { supplierId: supplierAId } }),
    );
    expect(routesFromB).toHaveLength(0);
    const probedRoute = await withTenant(companyBId, (tx) =>
      tx.route.findUnique({ where: { id: deliveryRouteAId } }),
    );
    expect(probedRoute).toBeNull();

    // ...and neither link leaks through the new Supplier back-relations.
    const viaSupplier = await withTenant(companyBId, (tx) =>
      tx.supplier.findMany({ include: { deliveryOrders: true, routes: true } }),
    );
    expect(viaSupplier.flatMap((s) => s.deliveryOrders)).toHaveLength(0);
    expect(viaSupplier.flatMap((s) => s.routes)).toHaveLength(0);
  });

  it('rejects a SalesOrder/Route whose deliverer is another tenant’s supplier', async () => {
    await expect(
      systemPrisma.salesOrder.create({
        data: {
          companyId: companyAId,
          number: 'ISO-SUP-XT',
          customerId: customerAId,
          warehouseId: warehouseAId,
          supplierId: supplierBId,
        },
      }),
    ).rejects.toThrow(/cross-tenant/i);

    // UPDATE is guarded too, not just INSERT: re-assigning an existing route's
    // deliverer is the easier way to stitch two tenants together. Re-pointing
    // the already-supplier-served route keeps the agent/supplier XOR satisfied,
    // so this asserts the cross-tenant guard and not the CHECK constraint.
    await expect(
      systemPrisma.route.update({ where: { id: deliveryRouteAId }, data: { supplierId: supplierBId } }),
    ).rejects.toThrow(/cross-tenant/i);

    const untouched = await systemPrisma.route.findUnique({ where: { id: deliveryRouteAId } });
    expect(untouched?.supplierId).toBe(supplierAId);

    // Selective, not "always throws": the all-company-A assignment is accepted.
    const ok = await withTenant(companyAId, (tx) =>
      tx.salesOrder.create({
        data: {
          companyId: companyAId,
          number: 'ISO-SUP-OK',
          customerId: customerAId,
          warehouseId: warehouseAId,
          supplierId: supplierAId,
        },
      }),
    );
    expect(ok.supplierId).toBe(supplierAId);
    await systemPrisma.salesOrder.delete({ where: { id: ok.id } });
  });

  // 20260810130000_route_agent_or_supplier: "Route"."agentId" is nullable now,
  // so the only thing standing between the schema and an ownerless (or
  // double-owned) route is the CHECK constraint. Enforced in the database, not
  // in a service, so it holds for the miniapp sync path and for BYPASSRLS
  // `velto_system` too.
  it('rejects a Route with neither an agent nor a supplier', async () => {
    await expect(
      withTenant(companyAId, (tx) =>
        tx.route.create({ data: { companyId: companyAId, weekday: 6, name: 'Ownerless Route' } }),
      ),
    ).rejects.toThrow(/Route_agent_xor_supplier_check|check constraint/i);

    // Same for an UPDATE that strips the last owner off an existing route.
    await expect(
      systemPrisma.route.update({ where: { id: routeAId }, data: { agentId: null } }),
    ).rejects.toThrow(/Route_agent_xor_supplier_check|check constraint/i);

    const stillOwned = await systemPrisma.route.findUnique({ where: { id: routeAId } });
    expect(stillOwned?.agentId).toBe(recipientId);
  });

  it('rejects a Route assigned to both an agent and a supplier', async () => {
    await expect(
      withTenant(companyAId, (tx) =>
        tx.route.create({
          data: {
            companyId: companyAId,
            agentId: recipientId,
            supplierId: supplierAId,
            weekday: 6,
            name: 'Double-owned Route',
          },
        }),
      ),
    ).rejects.toThrow(/Route_agent_xor_supplier_check|check constraint/i);

    // Adding a deliverer to an agent route, and an agent to a supplier route,
    // are the two realistic ways an API handler would break the invariant.
    await expect(
      systemPrisma.route.update({ where: { id: routeAId }, data: { supplierId: supplierAId } }),
    ).rejects.toThrow(/Route_agent_xor_supplier_check|check constraint/i);

    await expect(
      systemPrisma.route.update({ where: { id: deliveryRouteAId }, data: { agentId: recipientId } }),
    ).rejects.toThrow(/Route_agent_xor_supplier_check|check constraint/i);

    // Selective, not "always throws": both single-owner shapes are accepted,
    // and swapping one owner for the other in a single statement is legal.
    const agentOnly = await withTenant(companyAId, (tx) =>
      tx.route.create({ data: { companyId: companyAId, agentId: recipientId, weekday: 6, name: 'Agent Route' } }),
    );
    const swapped = await withTenant(companyAId, (tx) =>
      tx.route.update({ where: { id: agentOnly.id }, data: { agentId: null, supplierId: supplierAId } }),
    );
    expect(swapped.agentId).toBeNull();
    expect(swapped.supplierId).toBe(supplierAId);

    await systemPrisma.route.delete({ where: { id: agentOnly.id } });
  });

  // Guards the "do not touch existing Route/RouteStop" constraint: the new
  // tables must not have become visible to the agent-route readers.
  it('SupplierRoute rows do not appear in the agent Route/RouteStop tables', async () => {
    const routes = await withTenant(companyAId, (tx) => tx.route.findMany());
    expect(new Set(routes.map((r) => r.id))).toEqual(new Set([routeAId, deliveryRouteAId]));
    // `agentId !== null` no longer discriminates the two tables now that a
    // supplier-served Route may have none (20260810130000), so assert the
    // pickup-route ids are absent directly.
    expect(routes.map((r) => r.id)).not.toContain(supplierRouteAId);
    expect(routes.map((r) => r.id)).not.toContain(supplierRouteBId);

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
