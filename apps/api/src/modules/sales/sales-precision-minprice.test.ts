import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { grantRole } from '../../common/testing/grant-role';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { VisitsService } from '../field/visits/visits.service';
import { NotificationsService } from '../notifications/notifications.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';
import { StockService } from '../stock/stock.service';
import { SyncDocType } from '../sync/dto/sync-push.dto';
import { SyncService } from '../sync/sync.service';
import { SalesService } from './sales.service';

type AppErr = { getStatus(): number; getResponse(): { code: string; details: Record<string, unknown> } };

/** ADR-059a (qty ≤ 3 dp in base unit, reject not round) and ADR-059b (effective price ≥ minPrice, create + confirm). */
describe('ADR-059a/059b: qty precision and minPrice (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const docNumbering = new DocumentNumberingService();
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, new NotificationsService(tenantPrisma, new ConfigService()));
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering, makeOwnerAlerts(tenantPrisma));
  const sync = new SyncService(tenantPrisma, sales, payments, new VisitsService(tenantPrisma, auditLog), customers, new ConfigService({ SYNC_PUSH_MAX_BATCH: 20 }));

  let companyId: string;
  let user: AuthenticatedUser;
  let agent: AuthenticatedUser;
  let warehouseId: string;
  let customerId: string;
  let productA: string; // price 1000, VAT 12
  let pkgA1: string; // factor 1
  let pkgA15: string; // factor 1.5
  let productB: string; // price 333.33, VAT 12, no minPrice
  let pkgB1: string;

  const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);
  const createOrder = (lines: { productId: string; packagingId: string; qty: number; discountPct?: number }[], u = user, clientId?: string) =>
    run(() => sales.create({ customerId, lines, ...(clientId ? { clientId } : {}) }, u));
  const caught = <T>(p: Promise<T>) => p.then(() => null, (e: unknown) => e as AppErr);
  const setMinPrice = (productId: string, minPrice: string | null) =>
    tenantPrisma.run(companyId, (tx) => tx.product.update({ where: { id: productId }, data: { minPrice } }));
  const snapshot = () =>
    tenantPrisma.run(companyId, async (tx) => ({
      orders: await tx.salesOrder.count(),
      lines: await tx.salesOrderLine.count(),
      movements: await tx.stockMovement.count(),
      levels: (await tx.stockLevel.findMany({ where: { warehouseId }, orderBy: { productId: 'asc' } })).map((l) => `${l.productId}:${l.onHand.toString()}:${l.reserved.toString()}`),
    }));

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-prec-min-${Date.now()}`, name: 'Precision MinPrice Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Precision MinPrice Co' } })).id;
    const phone = () => `+99890${Math.floor(1000000 + Math.random() * 8999999)}`;
    const opUser = await systemPrisma.user.create({ data: { companyId, firstName: 'Op', lastName: 'Prec', phone: phone() } });
    user = { id: opUser.id, companyId, firstName: 'Op', lastName: 'Prec', roles: ['WAREHOUSE'], permissions: ['orders.create', 'orders.update'] };
    const agentUser = await systemPrisma.user.create({ data: { companyId, firstName: 'Agent', lastName: 'Prec', phone: phone() } });
    agent = { id: agentUser.id, companyId, firstName: 'Agent', lastName: 'Prec', roles: ['SALES_AGENT'], permissions: ['orders.create', 'payments.create', 'field.create'] };
    await grantRole(companyId, agentUser.id, 'SALES_AGENT', agent.permissions);

    await tenantPrisma.run(companyId, async (tx) => {
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'WH' } })).id;
      productA = (await tx.product.create({ data: { companyId, sku: 'PREC-A', name: 'Prec A', baseUnit: 'kg', vatRate: 12 } })).id;
      pkgA1 = (await tx.productPackaging.create({ data: { productId: productA, name: 'kg', qtyInBaseUnit: '1', isDefault: true } })).id;
      pkgA15 = (await tx.productPackaging.create({ data: { productId: productA, name: 'bag 1.5kg', qtyInBaseUnit: '1.5' } })).id;
      productB = (await tx.product.create({ data: { companyId, sku: 'PREC-B', name: 'Prec B', baseUnit: 'dona', vatRate: 12 } })).id;
      pkgB1 = (await tx.productPackaging.create({ data: { productId: productB, name: 'dona', qtyInBaseUnit: '1', isDefault: true } })).id;
      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: productA, price: '1000.00' } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: productB, price: '333.33' } });
      customerId = (await tx.customer.create({ data: { companyId, code: `PREC-${Date.now()}`, name: 'Prec Cust' } })).id;
    });
    await run(() => stock.receive({ productId: productA, warehouseId, qty: 1000 }, user));
    await run(() => stock.receive({ productId: productB, warehouseId, qty: 1000 }, user));
  });

  beforeEach(async () => {
    await setMinPrice(productA, null);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  describe('ADR-059a qty precision', () => {
    it('rejects 1.111 pkg × 1.5 = 1.6665 base units with ORDER_QTY_PRECISION; nothing written, stock unchanged', async () => {
      const before = await snapshot();
      const err = await caught(createOrder([{ productId: productA, packagingId: pkgA15, qty: 1.111 }]));
      expect(err?.getStatus()).toBe(400);
      expect(err?.getResponse().code).toBe('ORDER_QTY_PRECISION');
      expect(err?.getResponse().details).toMatchObject({ productId: productA, packagingId: pkgA15, qty: '1.111', qtyInBaseUnit: '1.5', baseQty: '1.6665', maxDecimals: 3 });
      expect(await snapshot()).toEqual(before);
    });

    it('rejects 0.125 pkg × 1.5 = 0.1875 base units', async () => {
      const err = await caught(createOrder([{ productId: productA, packagingId: pkgA15, qty: 0.125 }]));
      expect(err?.getResponse().code).toBe('ORDER_QTY_PRECISION');
      expect(err?.getResponse().details).toMatchObject({ baseQty: '0.1875' });
    });

    it('rejects an entered qty with more than 3 dp even at factor 1', async () => {
      const err = await caught(createOrder([{ productId: productA, packagingId: pkgA1, qty: 1.0001 }]));
      expect(err?.getResponse().code).toBe('ORDER_QTY_PRECISION');
    });

    it('accepts 0.2 pkg × 1.5 = 0.3 base units exactly', async () => {
      const order = await createOrder([{ productId: productA, packagingId: pkgA15, qty: 0.2 }]);
      expect(order.lines[0]!.qty.toString()).toBe('0.3');
      expect(order.lines[0]!.lineTotal.toFixed(2)).toBe('336.00'); // 0.3 × 1000 × 1.12
    });

    it('multi-line HALF_UP totals unchanged', async () => {
      // B: 1 × 333.33 × 0.93 × 1.12 = 347.196528 → 347.20 ; A: 0.3 × 1000 × 1.12 = 336.00
      const order = await createOrder([
        { productId: productA, packagingId: pkgA15, qty: 0.2 },
        { productId: productB, packagingId: pkgB1, qty: 1, discountPct: 7 },
      ]);
      expect(order.lines.map((l) => l.lineTotal.toFixed(2)).sort()).toEqual(['336.00', '347.20']);
      expect(order.total.toFixed(2)).toBe('683.20');
    });
  });

  describe('ADR-059b minPrice', () => {
    it('minPrice 500: discount 0 and 50 (= minPrice) accepted, 100 and 50.01 rejected with details', async () => {
      await setMinPrice(productA, '500.00');
      await createOrder([{ productId: productA, packagingId: pkgA1, qty: 1, discountPct: 0 }]);
      await createOrder([{ productId: productA, packagingId: pkgA1, qty: 1, discountPct: 50 }]);

      const before = await snapshot();
      const full = await caught(createOrder([{ productId: productA, packagingId: pkgA1, qty: 1, discountPct: 100 }]));
      expect(full?.getStatus()).toBe(400);
      expect(full?.getResponse().code).toBe('ORDER_PRICE_BELOW_MIN');
      expect(full?.getResponse().details).toEqual({ productId: productA, effectivePrice: '0', minPrice: '500.00' });
      const just = await caught(createOrder([{ productId: productA, packagingId: pkgA1, qty: 1, discountPct: 50.01 }]));
      expect(just?.getResponse().details).toMatchObject({ effectivePrice: '499.9' });
      expect(await snapshot()).toEqual(before);
    });

    it('packaging factor ≠ 1 compares the base-unit price, not the packaging price', async () => {
      await setMinPrice(productA, '500.00');
      // 2 bags × 1.5 = 3 kg; base price 1000 × 0.4 = 400 < 500 even though a bag "costs" 600
      const err = await caught(createOrder([{ productId: productA, packagingId: pkgA15, qty: 2, discountPct: 60 }]));
      expect(err?.getResponse().code).toBe('ORDER_PRICE_BELOW_MIN');
      expect(err?.getResponse().details).toMatchObject({ effectivePrice: '400' });
      const ok = await createOrder([{ productId: productA, packagingId: pkgA15, qty: 2, discountPct: 0 }]);
      expect(ok.lines[0]!.qty.toString()).toBe('3');
    });

    it('confirm after minPrice raised is rejected; order, lines, stock untouched', async () => {
      const order = await createOrder([{ productId: productA, packagingId: pkgA1, qty: 2 }]);
      await setMinPrice(productA, '1200.00');
      const before = await snapshot();
      const err = await caught(run(() => sales.confirm(order.id, user)));
      expect(err?.getStatus()).toBe(400);
      expect(err?.getResponse().code).toBe('ORDER_PRICE_BELOW_MIN');
      expect(err?.getResponse().details).toEqual({ productId: productA, effectivePrice: '1000', minPrice: '1200.00' });
      expect(await snapshot()).toEqual(before);
      const after = await tenantPrisma.run(companyId, (tx) => tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } }));
      expect(after.status).toBe('SUBMITTED');
      expect(after.lines[0]!.unitPrice.toFixed(2)).toBe('1000.00');
      expect(after.lines[0]!.lineTotal.toFixed(2)).toBe(order.lines[0]!.lineTotal.toFixed(2));
    });
  });

  describe('sync push and clientId replay', () => {
    const orderDoc = (clientId: string, line: { productId: string; packagingId: string; qty: number; discountPct?: number }) => ({
      type: SyncDocType.ORDER,
      clientId,
      payload: { customerId, clientId, lines: [line] },
    });

    it('sync push: precision and minPrice violations come back REJECTED with their codes, nothing written', async () => {
      await setMinPrice(productA, '500.00');
      const before = await snapshot();
      const { results } = await sync.push(
        [orderDoc(randomUUID(), { productId: productA, packagingId: pkgA15, qty: 1.111 }), orderDoc(randomUUID(), { productId: productA, packagingId: pkgA1, qty: 1, discountPct: 60 })],
        agent,
      );
      expect(results.map((r) => r.status)).toEqual(['REJECTED', 'REJECTED']);
      expect(results.map((r) => r.error?.code)).toEqual(['ORDER_QTY_PRECISION', 'ORDER_PRICE_BELOW_MIN']);
      expect(await snapshot()).toEqual(before);
    });

    it('clientId replay returns the original order even after minPrice was raised above its price', async () => {
      const clientId = randomUUID();
      const doc = orderDoc(clientId, { productId: productA, packagingId: pkgA1, qty: 1 });
      const first = await sync.push([doc], agent);
      expect(first.results[0]?.status).toBe('ACCEPTED');
      await setMinPrice(productA, '5000.00');
      const before = await snapshot();
      const again = await sync.push([doc], agent);
      expect(again.results[0]?.status).toBe('DUPLICATE');
      expect(again.results[0]?.id).toBe(first.results[0]?.id);
      const direct = await createOrder([{ productId: productA, packagingId: pkgA1, qty: 1 }], agent, clientId);
      expect(direct.id).toBe(first.results[0]?.id);
      expect(await snapshot()).toEqual(before);
    });
  });
});
