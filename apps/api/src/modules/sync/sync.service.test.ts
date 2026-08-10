import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { VisitsService } from '../field/visits/visits.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SuppliersService } from '../purchases/suppliers/suppliers.service';
import { SalesService } from '../sales/sales.service';
import { StockService } from '../stock/stock.service';
import { SyncDocType } from './dto/sync-push.dto';
import { SyncService } from './sync.service';

describe('SyncService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser; // SALES_AGENT
  let warehouseId: string;
  let productId: string;
  let packagingId: string;
  let customerId: string;
  let outletId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog);
  const docNumbering = new DocumentNumberingService();
  const suppliers = new SuppliersService(tenantPrisma, auditLog);
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, suppliers, notifications);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering);
  const visits = new VisitsService(tenantPrisma, auditLog);
  const sync = new SyncService(tenantPrisma, sales, payments, visits);

  const OUTLET_LAT = 41.2995;
  const OUTLET_LNG = 69.2401;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-sync-${Date.now()}`, name: 'Sync Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Sync Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Agent', lastName: 'Sync', phone: '+998900000040' },
    });
    user = {
      id: dbUser.id,
      companyId,
      firstName: 'Agent',
      lastName: 'Sync',
      roles: ['SALES_AGENT'],
      permissions: ['orders.create', 'payments.create', 'field.create'],
    };

    await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Sync Test Warehouse' } });
      warehouseId = warehouse.id;

      const product = await tx.product.create({
        data: { companyId, sku: 'SYNC-TEST-1', name: 'Sync Test Product', baseUnit: 'dona', vatRate: 12 },
      });
      productId = product.id;
      const packaging = await tx.productPackaging.create({
        data: { productId: product.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true },
      });
      packagingId = packaging.id;

      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: product.id, price: '10000' } });

      const customer = await tx.customer.create({
        data: { companyId, code: `SYNC-CUST-${Date.now()}`, name: 'Sync Test Customer' },
      });
      customerId = customer.id;
      const outlet = await tx.outlet.create({
        data: { companyId, customerId: customer.id, name: 'Sync Test Outlet', latitude: OUTLET_LAT, longitude: OUTLET_LNG },
      });
      outletId = outlet.id;
    });

    await tenantPrisma.run(companyId, () => stock.receive({ productId, warehouseId, qty: 1000 }, user));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  describe('pull', () => {
    it('returns everything on the first pull, and only later changes on a delta pull', async () => {
      const first = await tenantPrisma.run(companyId, () => sync.pull(undefined, undefined, user));
      expect(first.products.some((p) => p.id === productId)).toBe(true);
      expect(first.customers.some((c) => c.id === customerId)).toBe(true);

      const cursor = first.cursor;
      const secondProduct = await tenantPrisma.run(companyId, (tx) =>
        tx.product.create({
          data: { companyId, sku: 'SYNC-TEST-2', name: 'Second Product', baseUnit: 'dona', vatRate: 12 },
        }),
      );

      const delta = await tenantPrisma.run(companyId, () => sync.pull(cursor, undefined, user));
      expect(delta.products.map((p) => p.id)).toEqual([secondProduct.id]);
      expect(delta.customers.some((c) => c.id === customerId)).toBe(false);
    });

    it('includes product categories, delta-filtered the same way as products', async () => {
      const first = await tenantPrisma.run(companyId, () => sync.pull(undefined, undefined, user));
      const cursor = first.cursor;

      const category = await tenantPrisma.run(companyId, (tx) =>
        tx.productCategory.create({ data: { companyId, name: 'Sync Test Category' } }),
      );

      const delta = await tenantPrisma.run(companyId, () => sync.pull(cursor, undefined, user));
      expect(delta.categories.map((c) => c.id)).toEqual([category.id]);
    });

    it("returns the company's default price list id, matching SalesService's own fallback lookup", async () => {
      const result = await tenantPrisma.run(companyId, () => sync.pull(undefined, undefined, user));
      const priceList = await tenantPrisma.run(companyId, (tx) => tx.priceList.findFirst({ where: { isDefault: true } }));
      expect(result.defaultPriceListId).toBe(priceList!.id);
    });

    it("returns the agent's routes as a full snapshot regardless of `since`", async () => {
      const route = await tenantPrisma.run(companyId, (tx) =>
        tx.route.create({ data: { companyId, agentId: user.id, weekday: 1, name: 'Sync Test Route' } }),
      );
      await tenantPrisma.run(companyId, (tx) =>
        tx.routeStop.create({ data: { routeId: route.id, outletId, sortOrder: 1 } }),
      );

      const farFutureSince = new Date(Date.now() + 3_600_000).toISOString();
      const result = await tenantPrisma.run(companyId, () => sync.pull(farFutureSince, undefined, user));

      expect(result.routes.some((r) => r.id === route.id)).toBe(true);
      expect(result.routeStops.some((s) => s.routeId === route.id)).toBe(true);
    });
  });

  describe('push', () => {
    it('accepts a valid order, visit, and payment in one batch', async () => {
      const orderClientId = randomUUID();
      const visitClientId = randomUUID();
      const paymentClientId = randomUUID();

      const { results } = await tenantPrisma.run(companyId, () =>
        sync.push(
          [
            {
              type: SyncDocType.ORDER,
              clientId: orderClientId,
              payload: { customerId, clientId: orderClientId, lines: [{ productId, packagingId, qty: 2 }] },
            },
            {
              type: SyncDocType.VISIT,
              clientId: visitClientId,
              payload: {
                outletId,
                clientId: visitClientId,
                startedAt: new Date().toISOString(),
                latitude: OUTLET_LAT,
                longitude: OUTLET_LNG,
                outcome: 'ORDERED',
              },
            },
            {
              type: SyncDocType.PAYMENT,
              clientId: paymentClientId,
              payload: { customerId, clientId: paymentClientId, amount: 5000, method: 'CASH' },
            },
          ],
          user,
        ),
      );

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === 'ACCEPTED')).toBe(true);
      expect(results.every((r) => r.id)).toBe(true);
    });

    it('reports DUPLICATE when the same clientId is pushed twice', async () => {
      const clientId = randomUUID();
      const doc = {
        type: SyncDocType.ORDER,
        clientId,
        payload: { customerId, clientId, lines: [{ productId, packagingId, qty: 1 }] },
      };

      const first = await tenantPrisma.run(companyId, () => sync.push([doc], user));
      expect(first.results[0]?.status).toBe('ACCEPTED');

      const second = await tenantPrisma.run(companyId, () => sync.push([doc], user));
      expect(second.results[0]?.status).toBe('DUPLICATE');
      expect(second.results[0]?.id).toBe(first.results[0]?.id);
    });

    it('reports REJECTED for an order against a customer blocked while the agent was offline (10.4) — never silently dropped', async () => {
      const blockedCustomer = await tenantPrisma.run(companyId, (tx) =>
        tx.customer.create({
          data: {
            companyId,
            code: `SYNC-BLOCKED-${Date.now()}`,
            name: 'Blocked Customer',
            isBlocked: true,
          },
        }),
      );
      const clientId = randomUUID();

      const { results } = await tenantPrisma.run(companyId, () =>
        sync.push(
          [
            {
              type: SyncDocType.ORDER,
              clientId,
              payload: { customerId: blockedCustomer.id, clientId, lines: [{ productId, packagingId, qty: 1 }] },
            },
          ],
          user,
        ),
      );

      expect(results[0]?.status).toBe('REJECTED');
      expect(results[0]?.error?.code).toBe('SALES_CUSTOMER_BLOCKED');
    });

    it('reports REJECTED with a validation error for a malformed document, without blocking the rest of the batch', async () => {
      const badClientId = randomUUID();
      const goodClientId = randomUUID();

      const { results } = await tenantPrisma.run(companyId, () =>
        sync.push(
          [
            { type: SyncDocType.ORDER, clientId: badClientId, payload: { clientId: badClientId, lines: [] } },
            {
              type: SyncDocType.PAYMENT,
              clientId: goodClientId,
              payload: { customerId, clientId: goodClientId, amount: 1000, method: 'CASH' },
            },
          ],
          user,
        ),
      );

      expect(results[0]?.status).toBe('REJECTED');
      expect(results[0]?.error?.code).toBe('SYNC_VALIDATION_FAILED');
      expect(results[1]?.status).toBe('ACCEPTED');
    });
  });
});
