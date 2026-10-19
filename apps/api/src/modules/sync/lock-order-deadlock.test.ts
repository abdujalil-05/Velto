import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { expectWithinBudget } from '../../common/testing/perf';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { VisitsService } from '../field/visits/visits.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SalesService } from '../sales/sales.service';
import { StockService } from '../stock/stock.service';
import { SyncDocType, type SyncPushDocumentDto } from './dto/sync-push.dto';
import { SyncService } from './sync.service';

/**
 * F7 load finding (A): 40P01 between sync push (Customer FOR UPDATE -> SO
 * counter), POST /orders (SO counter -> SalesOrder INSERT, whose FK check
 * waits on the Customer row) and deliver (Customer -> StockLevel -> INV
 * counter). Global lock order (see DocumentNumberingService): every row lock
 * (Customer, StockLevel, Invoice) before any DocumentCounter, counters in
 * docType asc. This drives all writer paths concurrently on ONE customer and
 * the shared counters and requires zero deadlocks / zero RETRY.
 * (B): 20-document push budget (TZ 12.5, <3 s) under PERF=1.
 */
describe('Writer lock order: sync push x orders x deliver x payments (real Postgres + RLS)', () => {
  let companyId: string;
  let agent: AuthenticatedUser;
  let director: AuthenticatedUser;
  let warehouseId: string;
  const productIds: string[] = [];
  const packagingIds: string[] = [];
  const customerIds: string[] = [];
  const outletIds: string[] = [];

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
  const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-lockorder-${Date.now()}`, name: 'Lock Order Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Lock Order Co' } })).id;
    const mk = async (phone: string, roles: string[], permissions: string[]): Promise<AuthenticatedUser> => {
      const u = await systemPrisma.user.create({ data: { companyId, firstName: 'U', lastName: phone, phone } });
      return { id: u.id, companyId, firstName: 'U', lastName: phone, roles, permissions };
    };
    agent = await mk(`+99890${Date.now() % 10000000}`.slice(0, 13), ['SALES_AGENT'], ['orders.create', 'payments.create', 'field.create']);
    director = await mk(`+99891${Date.now() % 10000000}`.slice(0, 13), ['SALES_DIRECTOR'], ['orders.create', 'orders.confirm', 'orders.deliver', 'payments.create']);

    await run(async () => {
      const tx = tenantPrisma.client;
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'LO Warehouse' } })).id;
      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      for (let i = 0; i < 3; i++) {
        const p = await tx.product.create({ data: { companyId, sku: `LO-${i}`, name: `LO ${i}`, baseUnit: 'dona', vatRate: 12 } });
        productIds.push(p.id);
        packagingIds.push((await tx.productPackaging.create({ data: { productId: p.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true } })).id);
        await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: p.id, price: '1000' } });
      }
      for (let i = 0; i < 3; i++) {
        const c = await tx.customer.create({ data: { companyId, code: `LO-C${i}-${Date.now()}`, name: `LO C${i}` } });
        customerIds.push(c.id);
        outletIds.push((await tx.outlet.create({ data: { companyId, customerId: c.id, name: `LO O${i}` } })).id);
      }
    });
    for (const productId of productIds) await run(() => stock.receive({ productId, warehouseId, qty: 100000 }, director));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const orderPayload = (c: number, reverse = false) => {
    const lines = productIds.map((productId, i) => ({ productId, packagingId: packagingIds[i]!, qty: 1 }));
    return { customerId: customerIds[c]!, outletId: outletIds[c]!, warehouseId, lines: reverse ? lines.reverse() : lines };
  };
  const orderDoc = (c: number, reverse = false): SyncPushDocumentDto => ({ type: SyncDocType.ORDER, clientId: randomUUID(), payload: orderPayload(c, reverse) });
  const paymentDoc = (c: number): SyncPushDocumentDto => ({
    type: SyncDocType.PAYMENT,
    clientId: randomUUID(),
    payload: { customerId: customerIds[c]!, amount: '500', method: 'CASH' },
  });

  const isDeadlockOrTimeout = (e: unknown) => /deadlock|40P01|P2034|Transaction already closed|expired/i.test(`${(e as Error)?.message} ${JSON.stringify((e as { meta?: unknown })?.meta ?? {})}`);

  it('N=12 concurrent writers x 3 rounds on one customer + shared counters: 0 deadlocks, 0 RETRY', async () => {
    for (let round = 0; round < 3; round++) {
      // Orders to deliver this round (CONFIRMED, reserved), all on customer 0.
      const toDeliver: string[] = [];
      for (let i = 0; i < 3; i++) {
        const o = await run(() => sales.create(orderPayload(0, i % 2 === 1), director));
        await run(() => sales.confirm(o.id, director));
        toDeliver.push(o.id);
      }

      const ops: Array<Promise<unknown>> = [
        // sync batches: same customer, plus opposite docType order on other customers (SO/PAY counter inversion).
        run(() => sync.push([orderDoc(0), paymentDoc(0), orderDoc(1)], agent)),
        run(() => sync.push([paymentDoc(1), orderDoc(0, true), paymentDoc(0)], agent)),
        run(() => sync.push([orderDoc(2), paymentDoc(2)], agent)),
        run(() => sync.push([paymentDoc(2), orderDoc(2, true)], agent)),
        // POST /orders (online) on the same customer.
        run(() => sales.create(orderPayload(0), director)),
        run(() => sales.create(orderPayload(0, true), director)),
        run(() => sales.create(orderPayload(1), director)),
        // POST /payments (office -> POSTED, FIFO over customer 0's invoices).
        run(() => payments.create({ customerId: customerIds[0]!, amount: '700', method: 'CASH' } as never, director)),
        run(() => payments.create({ customerId: customerIds[0]!, amount: '300', method: 'CASH' } as never, director)),
        // deliver: SalesOrder -> Customer -> StockLevel -> INV counter.
        ...toDeliver.map((id) => run(() => sales.deliver(id, director))),
      ];
      const settled = await Promise.allSettled(ops);

      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => s.reason as unknown);
      expect(rejected.filter(isDeadlockOrTimeout).map((e) => (e as Error).message.slice(0, 200))).toEqual([]);
      expect(rejected.map((e) => (e as Error).message.slice(0, 200))).toEqual([]);

      const syncResults = settled.slice(0, 4).flatMap((s) => (s.status === 'fulfilled' ? (s.value as { results: Array<{ status: string }> }).results : []));
      expect(syncResults.map((r) => r.status).filter((st) => st !== 'ACCEPTED')).toEqual([]);
    }

    // Numbers stay unique and gap-free per docType (rolled back with their tx, never reused).
    const counters = await run(() => tenantPrisma.client.documentCounter.findMany());
    for (const c of counters) {
      const table = c.docType === 'SO' ? 'salesOrder' : c.docType === 'INV' ? 'invoice' : c.docType === 'PAY' ? 'payment' : null;
      if (!table) continue;
      const rows = await run(() => (tenantPrisma.client[table] as unknown as { findMany: (a: unknown) => Promise<Array<{ number: string }>> }).findMany({ select: { number: true } }));
      const nums = rows.map((r) => Number(r.number.split('-')[2])).sort((a, b) => a - b);
      expect(nums).toEqual(Array.from({ length: c.lastNumber }, (_, i) => i + 1));
    }
  }, 120_000);

  it('20-document push (17 orders x 2 lines + 3 payments, 3 customers) fits the 3 s budget', async () => {
    const docs: SyncPushDocumentDto[] = Array.from({ length: 20 }, (_, i) =>
      i % 7 === 6 ? paymentDoc(i % 3) : { ...orderDoc(i % 3), payload: { ...orderPayload(i % 3), lines: orderPayload(i % 3).lines.slice(0, 2) } },
    );
    const t0 = performance.now();
    const res = await run(() => sync.push(docs, agent));
    const ms = Math.round(performance.now() - t0);
    console.info(`[PERF] sync push 20 docs: ${ms} ms`);
    expect(res.results.every((r) => r.status === 'ACCEPTED')).toBe(true);
    expectWithinBudget('sync push 20 docs', ms, 3000);
  }, 30_000);

  it('per-type timing: 20 orders / 20 payments / 20 visits (logged)', async () => {
    const visitDoc = (i: number): SyncPushDocumentDto => ({
      type: SyncDocType.VISIT,
      clientId: randomUUID(),
      payload: { outletId: outletIds[i % 3]!, startedAt: new Date().toISOString(), outcome: 'NO_ORDER', noOrderReason: 'closed' },
    });
    const kinds: Array<[string, (i: number) => SyncPushDocumentDto]> = [
      ['order', (i) => orderDoc(i % 3)],
      ['payment', (i) => paymentDoc(i % 3)],
      ['visit', visitDoc],
    ];
    for (const [kind, make] of kinds) {
      const docs = Array.from({ length: 20 }, (_, i) => make(i));
      const t0 = performance.now();
      const res = await run(() => sync.push(docs, agent));
      console.info(`[PERF] sync push 20 ${kind}: ${Math.round(performance.now() - t0)} ms`);
      expect(res.results.map((r) => r.status).filter((s) => s !== 'ACCEPTED')).toEqual([]);
    }
  }, 30_000);
});
