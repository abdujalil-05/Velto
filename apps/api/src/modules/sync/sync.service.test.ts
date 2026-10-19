import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { Prisma, prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { grantRole } from '../../common/testing/grant-role';
import { envSchema } from '../../common/config/env.schema';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { VisitsService } from '../field/visits/visits.service';
import { NotificationsService } from '../notifications/notifications.service';
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
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, notifications);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering);
  const visits = new VisitsService(tenantPrisma, auditLog);
  const sync = new SyncService(tenantPrisma, sales, payments, visits, customers, new ConfigService({ SYNC_PUSH_MAX_BATCH: 20 }));

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
    // push re-reads roles/permissions from the DB per document (§8.4).
    await grantRole(companyId, dbUser.id, 'SALES_AGENT', user.permissions);

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
    // F4: a SALES_AGENT only sees own-route customers (covered in sync-pull.test.ts); these cases use tenant-wide scope.
    const director = (): AuthenticatedUser => ({ ...user, roles: ['SALES_DIRECTOR'] });

    it('returns everything on the first pull, and only later changes on a delta pull', async () => {
      const first = await tenantPrisma.run(companyId, () => sync.pull({}, director()));
      expect(first.products.some((p) => p.id === productId)).toBe(true);
      expect(first.customers.some((c) => c.id === customerId)).toBe(true);

      const cursor = first.cursor;
      const secondProduct = await tenantPrisma.run(companyId, (tx) =>
        tx.product.create({
          data: { companyId, sku: 'SYNC-TEST-2', name: 'Second Product', baseUnit: 'dona', vatRate: 12 },
        }),
      );

      const delta = await tenantPrisma.run(companyId, () => sync.pull({ cursor }, director()));
      // Lookback re-sends rows younger than the window (idempotent on the client); the new row must be there.
      expect(delta.products.map((p) => p.id)).toContain(secondProduct.id);
      expect(delta.fullResync).toBe(false);
    });

    it('includes product categories, delta-filtered the same way as products', async () => {
      const first = await tenantPrisma.run(companyId, () => sync.pull({}, director()));
      const cursor = first.cursor;

      const category = await tenantPrisma.run(companyId, (tx) =>
        tx.productCategory.create({ data: { companyId, name: 'Sync Test Category' } }),
      );

      const delta = await tenantPrisma.run(companyId, () => sync.pull({ cursor }, director()));
      expect(delta.categories.map((c) => c.id)).toContain(category.id);
    });

    it("returns the company's default price list id, matching SalesService's own fallback lookup", async () => {
      const result = await tenantPrisma.run(companyId, () => sync.pull({}, director()));
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

      // legacy ISO `since` is not a cursor -> full resync, routes still sent
      const farFutureSince = new Date(Date.now() + 3_600_000).toISOString();
      const result = await tenantPrisma.run(companyId, () => sync.pull({ cursor: farFutureSince }, user));

      expect(result.routes.some((r) => r.id === route.id)).toBe(true);
      expect(result.routeStops.some((s) => s.routeId === route.id)).toBe(true);
    });
  });

  describe('push', () => {
    it('accepts a valid order, visit, and payment in one batch', async () => {
      const orderClientId = randomUUID();
      const visitClientId = randomUUID();
      const paymentClientId = randomUUID();

      const { results } = await sync.push(
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
      );

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === 'ACCEPTED')).toBe(true);
      expect(results.every((r) => r.id)).toBe(true);
    });

    it('accepts an offline visit far from the outlet (OUTSIDE_RADIUS) and a no-GPS SKIPPED visit instead of REJECTED', async () => {
      const far = randomUUID();
      const skipped = randomUUID();
      const startedAt = new Date().toISOString();
      const doc = { type: SyncDocType.VISIT, clientId: far, payload: { outletId, startedAt, latitude: OUTLET_LAT + 0.01, longitude: OUTLET_LNG, accuracyM: 10, outcome: 'ORDERED' } };
      const { results } = await sync.push(
          [doc, { type: SyncDocType.VISIT, clientId: skipped, payload: { outletId, startedAt, permissionDenied: true, outcome: 'SKIPPED', skipReason: 'Yopiq' } }],
        user,
      );
      expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
      expect(results[0]?.gpsStatus).toBe('OUTSIDE_RADIUS');
      expect(Number(results[0]?.distanceM)).toBeGreaterThan(0);
      expect(results[1]?.gpsStatus).toBe('NO_PERMISSION');
      const stored = await tenantPrisma.run(companyId, (tx) => tx.visit.findUnique({ where: { companyId_clientId: { companyId, clientId: far } } }));
      expect(stored?.gpsStatus).toBe('OUTSIDE_RADIUS');
      const again = await sync.push([doc], user);
      expect(again.results[0]?.status).toBe('DUPLICATE');
      expect(again.results[0]?.gpsStatus).toBe('OUTSIDE_RADIUS');
      expect(again.results[0]?.distanceM).toBe(results[0]?.distanceM);
    });

    it('reports DUPLICATE when the same clientId is pushed twice', async () => {
      const clientId = randomUUID();
      const doc = {
        type: SyncDocType.ORDER,
        clientId,
        payload: { customerId, clientId, lines: [{ productId, packagingId, qty: 1 }] },
      };

      const first = await sync.push([doc], user);
      expect(first.results[0]?.status).toBe('ACCEPTED');

      const second = await sync.push([doc], user);
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

      const { results } = await sync.push(
          [
            {
              type: SyncDocType.ORDER,
              clientId,
              payload: { customerId: blockedCustomer.id, clientId, lines: [{ productId, packagingId, qty: 1 }] },
            },
          ],
        user,
      );

      expect(results[0]?.status).toBe('REJECTED');
      expect(results[0]?.error?.code).toBe('SALES_CUSTOMER_BLOCKED');
    });

    it('reports REJECTED with a validation error for a malformed document, without blocking the rest of the batch', async () => {
      const badClientId = randomUUID();
      const goodClientId = randomUUID();

      const { results } = await sync.push(
          [
            { type: SyncDocType.ORDER, clientId: badClientId, payload: { clientId: badClientId, lines: [] } },
            {
              type: SyncDocType.PAYMENT,
              clientId: goodClientId,
              payload: { customerId, clientId: goodClientId, amount: 1000, method: 'CASH' },
            },
          ],
        user,
      );

      expect(results[0]?.status).toBe('REJECTED');
      expect(results[0]?.error?.code).toBe('SYNC_VALIDATION_FAILED');
      expect(results[1]?.status).toBe('ACCEPTED');
    });

    it('ADR-029: agent cash pushed 3x in parallel with one clientId -> one PENDING_HANDOVER row, no allocation, balance untouched', async () => {
      const cust = await tenantPrisma.run(companyId, (tx) =>
        tx.customer.create({ data: { companyId, code: `SYNC-HO-${Date.now()}`, name: 'Handover Sync' } }),
      );
      await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.create({ data: { companyId, number: `SYNC-HO-INV-${Date.now()}`, customerId: cust.id, total: '5000', status: 'OPEN' } }),
      );
      const clientId = randomUUID();
      const doc = { type: SyncDocType.PAYMENT, clientId, payload: { customerId: cust.id, clientId, amount: 3000, method: 'CASH' } };
      const all = await Promise.all([1, 2, 3].map(() => sync.push([doc], user)));
      const items = all.map((r) => r.results[0]!);

      expect(new Set(items.map((i) => i.id)).size).toBe(1);
      expect(items.every((i) => i.status === 'ACCEPTED' || i.status === 'DUPLICATE')).toBe(true);
      expect(items.every((i) => i.paymentStatus === 'PENDING_HANDOVER')).toBe(true);
      const rows = await tenantPrisma.run(companyId, (tx) =>
        tx.payment.findMany({ where: { clientId }, include: { allocations: true } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('PENDING_HANDOVER');
      expect(rows[0]!.allocations).toHaveLength(0);
      const after = await tenantPrisma.run(companyId, (tx) => tx.customer.findUniqueOrThrow({ where: { id: cust.id } }));
      expect(after.cachedBalance.toString()).toBe('0'); // invoice inserted directly; pending cash never recomputes it
      expect((await tenantPrisma.run(companyId, (tx) => customers.getBalance(tx, cust.id))).toString()).toBe('5000');
    });

    it('race: two parallel batches paying the same customers in opposite order (A→B vs B→A) never deadlock, both apply fully, clientId stays idempotent', async () => {
      const [custA, custB] = await tenantPrisma.run(companyId, (tx) =>
        Promise.all(
          ['A', 'B'].map((k) => tx.customer.create({ data: { companyId, code: `SYNC-RACE-${k}-${Date.now()}`, name: `Race ${k}` } })),
        ),
      );
      const payDoc = (cust: string) => {
        const clientId = randomUUID();
        return { type: SyncDocType.PAYMENT, clientId, payload: { customerId: cust, clientId, amount: 1000, method: 'CASH' } };
      };
      const ROUNDS = 4;
      const allClientIds: string[] = [];

      for (let round = 0; round < ROUNDS; round++) {
        // Unknown customer in the batch: per-document REJECTED, never fails the batch.
        const ghost = payDoc(randomUUID());
        const batch1 = [payDoc(custA.id), ghost, payDoc(custB.id)];
        const batch2 = [payDoc(custB.id), payDoc(custA.id)];
        const settled = await Promise.allSettled([
          sync.push(batch1, user),
          sync.push(batch2, user),
        ]);
        for (const s of settled) {
          if (s.status === 'rejected') throw s.reason; // e.g. 40P01 deadlock
        }
        const [r1, r2] = settled.map((s) => (s as PromiseFulfilledResult<{ results: { status: string; error?: { code: string } }[] }>).value.results);
        expect(r1!.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED', 'ACCEPTED']);
        expect(r1![1]?.error?.code).toBe('CUSTOMER_NOT_FOUND');
        expect(r2!.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);

        // Same batches again: idempotent by clientId.
        const again = await sync.push([...batch2, ...batch1], user);
        expect(again.results.map((r) => r.status)).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'REJECTED', 'DUPLICATE']);
        allClientIds.push(...batch1.filter((d) => d !== ghost).map((d) => d.clientId), ...batch2.map((d) => d.clientId));
      }

      const counts = await tenantPrisma.run(companyId, (tx) =>
        Promise.all([custA.id, custB.id].map((id) => tx.payment.count({ where: { customerId: id } }))),
      );
      expect(counts).toEqual([ROUNDS * 2, ROUNDS * 2]);
      const byClientId = await tenantPrisma.run(companyId, (tx) => tx.payment.count({ where: { clientId: { in: allClientIds } } }));
      expect(byClientId).toBe(allClientIds.length);
    });
  });

  describe('push F4: result statuses (ACCEPTED | DUPLICATE | REJECTED | CONFLICT | RETRY)', () => {
    afterEach(() => vi.restoreAllMocks());

    const orderDoc = (opts: { expectedUnitPrice?: string; qty?: number; customer?: string } = {}) => {
      const clientId = randomUUID();
      const line = { productId, packagingId, qty: opts.qty ?? 1, ...(opts.expectedUnitPrice !== undefined && { expectedUnitPrice: opts.expectedUnitPrice }) };
      return { type: SyncDocType.ORDER, clientId, payload: { customerId: opts.customer ?? customerId, clientId, lines: [line] } };
    };
    const payDoc = () => {
      const clientId = randomUUID();
      return { type: SyncDocType.PAYMENT, clientId, payload: { customerId, clientId, amount: 1000, method: 'CASH' } };
    };
    const reservedQty = () =>
      tenantPrisma.run(companyId, async (tx) => (await tx.stockLevel.findFirst({ where: { productId, warehouseId } }))?.reserved.toString());
    const soCounter = () =>
      tenantPrisma.run(companyId, async (tx) => (await tx.documentCounter.findFirst({ where: { docType: 'SO', year: new Date().getFullYear() } }))?.lastNumber ?? 0);
    const orderByClientId = (clientId: string) =>
      tenantPrisma.run(companyId, (tx) => tx.salesOrder.findUnique({ where: { companyId_clientId: { companyId, clientId } } }));
    const pgError = (prismaCode: string, sqlState?: string) =>
      new Prisma.PrismaClientKnownRequestError('simulated', { code: prismaCode, clientVersion: 'test', ...(sqlState && { meta: { code: sqlState } }) });

    it('ACCEPTED when expectedUnitPrice equals the server price', async () => {
      const doc = orderDoc({ expectedUnitPrice: '10000.00' });
      const { results } = await sync.push([doc], user);
      expect(results[0]).toMatchObject({ clientId: doc.clientId, status: 'ACCEPTED' });
      expect((await orderByClientId(doc.clientId))?.id).toBe(results[0]?.id);
    });

    it('ACCEPTED as SUBMITTED with no reservation even when qty exceeds on-hand stock (8.4: never dropped; reserve only at confirm)', async () => {
      const reservedBefore = await reservedQty();
      const doc = orderDoc({ qty: 1_000_000 });
      const { results } = await sync.push([doc], user);
      expect(results[0]).toMatchObject({ clientId: doc.clientId, status: 'ACCEPTED' });
      expect((await orderByClientId(doc.clientId))?.status).toBe('SUBMITTED');
      expect(await reservedQty()).toBe(reservedBefore);
    });

    it('CONFLICT PRICE_CHANGED with line + total details; no order, no SO/INV number, no reserve written; rest of batch unaffected', async () => {
      const [counterBefore, reservedBefore, invoicesBefore] = await Promise.all([
        soCounter(),
        reservedQty(),
        tenantPrisma.run(companyId, (tx) => tx.invoice.count()),
      ]);
      const changed = orderDoc({ expectedUnitPrice: '9500', qty: 2 });
      const pay = payDoc();
      const { results } = await sync.push([changed, pay], user);

      expect(results[0]?.status).toBe('CONFLICT');
      expect(results[0]?.id).toBeUndefined();
      expect(results[0]?.error?.code).toBe('PRICE_CHANGED');
      expect(results[0]?.error?.messages?.ru).toBeTruthy();
      expect(results[0]?.error?.details).toEqual({
        lines: [{ lineIndex: 0, productId, packagingId, expectedUnitPrice: '9500.00', serverUnitPrice: '10000.00' }],
        expectedTotal: '21280.00', // 2 * 9500 * 1.12
        serverTotal: '22400.00', // 2 * 10000 * 1.12
      });
      expect(results[1]?.status).toBe('ACCEPTED');

      expect(await orderByClientId(changed.clientId)).toBeNull();
      expect(await soCounter()).toBe(counterBefore);
      expect(await reservedQty()).toBe(reservedBefore);
      expect(await tenantPrisma.run(companyId, (tx) => tx.invoice.count())).toBe(invoicesBefore);
    });

    it('race: two parallel pushes of the same order clientId → exactly one ACCEPTED, one DUPLICATE with the same serverId, one order row', async () => {
      const doc = orderDoc({ expectedUnitPrice: '10000' });
      const settled = await Promise.all([
        sync.push([doc], user),
        sync.push([doc], user),
      ]);
      const statuses = settled.map((r) => r.results[0]?.status).sort();
      expect(statuses).toEqual(['ACCEPTED', 'DUPLICATE']);
      expect(settled[0].results[0]?.id).toBe(settled[1].results[0]?.id);
      expect(await tenantPrisma.run(companyId, (tx) => tx.salesOrder.count({ where: { clientId: doc.clientId } }))).toBe(1);
    });

    it('P2002 lost race on clientId → DUPLICATE carrying the existing document id', async () => {
      const doc = orderDoc();
      const first = await sync.push([doc], user);
      vi.spyOn(sales, 'createWithOutcome').mockRejectedValueOnce(pgError('P2002'));
      const { results } = await sync.push([doc], user);
      expect(results[0]).toMatchObject({ status: 'DUPLICATE', id: first.results[0]?.id });
    });

    it('P2002 with no existing doc for the clientId → RETRY (not a duplicate)', async () => {
      vi.spyOn(sales, 'createWithOutcome').mockRejectedValueOnce(pgError('P2002'));
      const { results } = await sync.push([orderDoc()], user);
      expect(results[0]?.status).toBe('RETRY');
    });

    it.each([
      ['40001 serialization failure', pgError('P2010', '40001')],
      ['40P01 deadlock', pgError('P2034', '40P01')],
      ['55P03 lock timeout', pgError('P2010', '55P03')],
      ['unexpected infra error', new Error('connection reset')],
    ])('%s → RETRY with the document tx rolled back; the rest of the batch still applies', async (_name, failure) => {
      const doc = orderDoc();
      // Real write first, then fail — proves the document tx rollback discards it.
      vi.spyOn(sales, 'createWithOutcome').mockImplementationOnce(async (dto, u) => {
        await sales.create(dto, u);
        throw failure;
      });
      const pay = payDoc();
      const { results } = await sync.push([doc, pay], user);
      expect(results[0]).toMatchObject({ clientId: doc.clientId, status: 'RETRY', error: { code: 'SYNC_RETRY' } });
      expect(results[0]?.error?.message).not.toContain('simulated');
      expect(results[1]?.status).toBe('ACCEPTED');
      expect(await orderByClientId(doc.clientId)).toBeNull();
    });

    it('REJECTED for a blocked customer with a stable code and trilingual message, without affecting other items', async () => {
      const blocked = await tenantPrisma.run(companyId, (tx) =>
        tx.customer.create({ data: { companyId, code: `SYNC-F4-BLK-${Date.now()}`, name: 'F4 Blocked', isBlocked: true } }),
      );
      const ok = orderDoc({ expectedUnitPrice: '10000' });
      const { results } = await sync.push([orderDoc({ customer: blocked.id }), ok], user);
      expect(results[0]?.status).toBe('REJECTED');
      expect(results[0]?.error?.code).toBe('SALES_CUSTOMER_BLOCKED');
      expect(results[0]?.error?.messages).toEqual({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) });
      expect(results[1]?.status).toBe('ACCEPTED');
    });

    it('REJECTED for a permission failure (plain ForbiddenException → HTTP_403 with trilingual copy)', async () => {
      vi.spyOn(sales, 'createWithOutcome').mockRejectedValueOnce(new ForbiddenException());
      const { results } = await sync.push([orderDoc()], user);
      expect(results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'HTTP_403', messages: { en: 'Forbidden' } } });
    });

    it('batch limit comes from SYNC_PUSH_MAX_BATCH: over the limit → SYNC_BATCH_TOO_LARGE, nothing processed', async () => {
      const small = new SyncService(tenantPrisma, sales, payments, visits, customers, new ConfigService({ SYNC_PUSH_MAX_BATCH: 2 }));
      expect(small.maxBatch).toBe(2);
      const docs = [payDoc(), payDoc(), payDoc()];
      const err = await small.push(docs, user).catch((e: unknown) => e);
      expect((err as { getResponse(): { code: string } }).getResponse().code).toBe('SYNC_BATCH_TOO_LARGE');
      const written = await tenantPrisma.run(companyId, (tx) => tx.payment.count({ where: { clientId: { in: docs.map((d) => d.clientId) } } }));
      expect(written).toBe(0);
      const { results } = await small.push(docs.slice(0, 2), user);
      expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    });

    it('env schema: SYNC_PUSH_MAX_BATCH defaults to 20 and is bounded 1..100', () => {
      const base = { DATABASE_URL: 'x', DATABASE_SYSTEM_URL: 'x', REDIS_URL: 'x', JWT_ACCESS_SECRET: 'x'.repeat(32), S3_ENDPOINT: 'x', S3_ACCESS_KEY: 'x', S3_SECRET_KEY: 'x', S3_BUCKET: 'x' };
      expect(envSchema.parse(base).SYNC_PUSH_MAX_BATCH).toBe(20);
      expect(envSchema.parse({ ...base, SYNC_PUSH_MAX_BATCH: '50' }).SYNC_PUSH_MAX_BATCH).toBe(50);
      expect(envSchema.safeParse({ ...base, SYNC_PUSH_MAX_BATCH: '0' }).success).toBe(false);
      expect(envSchema.safeParse({ ...base, SYNC_PUSH_MAX_BATCH: '101' }).success).toBe(false);
    });
  });

  describe('push F7: one tx per document (@TenantTx handler scope)', () => {
    afterEach(() => vi.restoreAllMocks());

    const orderDoc = (customer = customerId) => {
      const clientId = randomUUID();
      return { type: SyncDocType.ORDER, clientId, payload: { customerId: customer, clientId, lines: [{ productId, packagingId, qty: 1 }] } };
    };
    const payDoc = () => {
      const clientId = randomUUID();
      return { type: SyncDocType.PAYMENT, clientId, payload: { customerId, clientId, amount: 1000, method: 'CASH' } };
    };
    const soNumbers = (clientIds: string[]) =>
      tenantPrisma.run(companyId, async (tx) =>
        (await tx.salesOrder.findMany({ where: { clientId: { in: clientIds } }, select: { number: true } })).map((o) => Number(o.number.split('-').pop())),
      );
    const soCounter = () =>
      tenantPrisma.run(companyId, async (tx) => (await tx.documentCounter.findFirst({ where: { docType: 'SO', year: new Date().getFullYear() } }))?.lastNumber ?? 0);
    const mkAgent = async (label: string): Promise<AuthenticatedUser> => {
      const u = await systemPrisma.user.create({ data: { companyId, firstName: label, lastName: 'Sync', phone: `+99893${String(Date.now()).slice(-7)}` } });
      await grantRole(companyId, u.id, 'SALES_AGENT', user.permissions);
      return { ...user, id: u.id, firstName: label };
    };

    it('20 docs, 7 commit then the connection drops (throw inside the doc tx) -> 7 ACCEPTED + 13 RETRY; re-push -> 7 DUPLICATE (same ids) + 13 ACCEPTED; SO numbers unique, no gaps', async () => {
      const docs = Array.from({ length: 20 }, () => orderDoc());
      const counterBefore = await soCounter();
      const real = sales.createWithOutcome.bind(sales);
      let n = 0;
      vi.spyOn(sales, 'createWithOutcome').mockImplementation(async (dto, u) => {
        const r = await real(dto, u); // real write + SO number taken, then the tx dies
        if (++n > 7) throw new Error('connection reset');
        return r;
      });
      const first = await sync.push(docs, user);
      expect(first.results.map((r) => r.status)).toEqual([...Array(7).fill('ACCEPTED'), ...Array(13).fill('RETRY')]);
      expect(first.results.map((r) => r.clientId)).toEqual(docs.map((d) => d.clientId));
      expect(await soCounter()).toBe(counterBefore + 7);
      vi.restoreAllMocks();

      const again = await sync.push(docs, user);
      expect(again.results.map((r) => r.status)).toEqual([...Array(7).fill('DUPLICATE'), ...Array(13).fill('ACCEPTED')]);
      expect(again.results.slice(0, 7).map((r) => r.id)).toEqual(first.results.slice(0, 7).map((r) => r.id));
      const nums = (await soNumbers(docs.map((d) => d.clientId))).sort((a, b) => a - b);
      expect(nums).toHaveLength(20);
      expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => counterBefore + 1 + i));
      expect(await soCounter()).toBe(counterBefore + 20);
    });

    it('race: one order clientId pushed 3x in parallel -> exactly 1 ACCEPTED + 2 DUPLICATE, same id, one row', async () => {
      const doc = orderDoc();
      const all = await Promise.all([1, 2, 3].map(() => sync.push([doc], user)));
      const items = all.map((r) => r.results[0]!);
      expect(items.map((i) => i.status).sort()).toEqual(['ACCEPTED', 'DUPLICATE', 'DUPLICATE']);
      expect(new Set(items.map((i) => i.id)).size).toBe(1);
      expect(await tenantPrisma.run(companyId, (tx) => tx.salesOrder.count({ where: { clientId: doc.clientId } }))).toBe(1);
    });

    it('§8.4 role removed mid-batch: docs already committed stay ACCEPTED, the rest REJECTED PERMISSION_DENIED, one audit row, nothing else written', async () => {
      const agent = await mkAgent('Revoked');
      const docs = [payDoc(), payDoc(), payDoc(), payDoc()];
      const real = payments.create.bind(payments);
      let n = 0;
      vi.spyOn(payments, 'create').mockImplementation(async (dto, u) => {
        const r = await real(dto, u);
        if (++n === 2) {
          await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
            await tx.userRole.deleteMany({ where: { userId: agent.id } });
          });
        }
        return r;
      });
      const { results } = await sync.push(docs, agent);
      expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'REJECTED', 'REJECTED']);
      expect(results[2]?.error?.code).toBe('PERMISSION_DENIED');
      const [written, audits] = await tenantPrisma.run(companyId, (tx) =>
        Promise.all([
          tx.payment.count({ where: { clientId: { in: docs.map((d) => d.clientId) } } }),
          tx.auditLog.count({ where: { action: 'auth.permission_denied', userId: agent.id } }),
        ]),
      );
      expect(written).toBe(2);
      expect(audits).toBe(1);
    });

    it.each([
      ['user', (id: string) => systemPrisma.user.update({ where: { id }, data: { isActive: false } })],
      ['company', () => systemPrisma.company.update({ where: { id: companyId }, data: { isActive: false } })],
    ] as const)('%s deactivated mid-batch: committed doc stays ACCEPTED, the rest RETRY ACCOUNT_INACTIVE, nothing else written', async (_k, deactivate) => {
      const agent = await mkAgent(`Deact-${_k}`);
      const docs = [payDoc(), payDoc(), payDoc()];
      const real = payments.create.bind(payments);
      let n = 0;
      vi.spyOn(payments, 'create').mockImplementation(async (dto, u) => {
        const r = await real(dto, u);
        if (++n === 1) await deactivate(agent.id);
        return r;
      });
      try {
        const { results } = await sync.push(docs, agent);
        expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'RETRY', 'RETRY']);
        expect(results[1]?.error?.code).toBe('ACCOUNT_INACTIVE');
      } finally {
        await systemPrisma.company.update({ where: { id: companyId }, data: { isActive: true } });
      }
      const written = await tenantPrisma.run(companyId, (tx) => tx.payment.count({ where: { clientId: { in: docs.map((d) => d.clientId) } } }));
      expect(written).toBe(1);
    });

    it('afterCommit callback throws after COMMIT -> the document stays ACCEPTED (not RETRY), row exists', async () => {
      const doc = orderDoc();
      const real = sales.createWithOutcome.bind(sales);
      vi.spyOn(sales, 'createWithOutcome').mockImplementationOnce(async (dto, u) => {
        const r = await real(dto, u);
        TenantContext.afterCommit(() => {
          throw new Error('enqueue failed');
        });
        return r;
      });
      const { results } = await sync.push([doc], user);
      expect(results[0]).toMatchObject({ clientId: doc.clientId, status: 'ACCEPTED' });
      expect(await tenantPrisma.run(companyId, (tx) => tx.salesOrder.count({ where: { clientId: doc.clientId } }))).toBe(1);
    });

    it('a concurrent POST /orders on the same customer slips in between push documents (does not wait for the 20-doc batch)', async () => {
      const director: AuthenticatedUser = { ...user, roles: ['SALES_DIRECTOR'] };
      const docs = Array.from({ length: 20 }, () => orderDoc());
      const counterBefore = await soCounter();
      const t0 = performance.now();
      let pushEnd = 0;
      const pushP = sync.push(docs, user).then((r) => ((pushEnd = performance.now()), r));
      // Start once the batch is under way (its first document committed).
      while ((await tenantPrisma.run(companyId, (tx) => tx.salesOrder.count({ where: { clientId: { in: docs.map((d) => d.clientId) } } }))) < 2) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const c0 = performance.now();
      const created = await tenantPrisma.run(companyId, () => sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] } as never, director));
      const createMs = performance.now() - c0;
      const createEnd = performance.now();
      const { results } = await pushP;
      const pushMs = pushEnd - t0;
      console.info(`[F7 micro] push 20 orders: ${pushMs.toFixed(0)} ms; concurrent order-create: ${createMs.toFixed(0)} ms`);
      expect(results.every((r) => r.status === 'ACCEPTED')).toBe(true);
      expect(created.id).toBeTruthy();
      expect(createEnd).toBeLessThan(pushEnd);
      const nums = (await soNumbers([...docs.map((d) => d.clientId)])).concat(Number(created.number.split('-').pop()));
      expect(new Set(nums).size).toBe(21);
      expect(nums.sort((a, b) => a - b)).toEqual(Array.from({ length: 21 }, (_, i) => counterBefore + 1 + i));
    });
  });
});
