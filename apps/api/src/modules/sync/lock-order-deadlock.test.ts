import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { grantRole } from '../../common/testing/grant-role';
import { expectWithinBudget } from '../../common/testing/perf';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { VisitsService } from '../field/visits/visits.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SalesService } from '../sales/sales.service';
import { StockService } from '../stock/stock.service';
import { SyncDocType, type SyncPushDocumentDto } from './dto/sync-push.dto';
import { SyncService } from './sync.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';

/**
 * F7 load finding (A): 40P01 between sync push (Customer FOR UPDATE -> SO
 * counter), POST /orders (SO counter -> SalesOrder INSERT, whose FK check
 * waits on the Customer row) and deliver (Customer -> StockLevel -> INV
 * counter). Global lock order (see DocumentNumberingService): every row lock
 * (Customer, StockLevel, Invoice) before any DocumentCounter, counters in
 * docType asc. This drives all writer paths concurrently on ONE customer and
 * the shared counters and requires zero deadlocks / zero RETRY.
 * (B): 20-document push budget (TZ 12.5, <3 s) under PERF=1.
 * (C) F7 late SO counter: order create INSERTs under a 'TMP-<uuid>' placeholder,
 * reserves, then takes the SO counter last; numbers stay gapless and TMP- never
 * escapes. Per-document lock_timeout 2 s -> 55P03 -> sync RETRY / HTTP 503.
 */
describe('Writer lock order: sync push x orders x deliver x payments (real Postgres + RLS)', () => {
  let companyId: string;
  let agent: AuthenticatedUser;
  let director: AuthenticatedUser;
  let courierId: string;
  let warehouseId: string;
  const productIds: string[] = [];
  const packagingIds: string[] = [];
  const customerIds: string[] = [];
  const outletIds: string[] = [];

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const docNumbering = new DocumentNumberingService();
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, notifications);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering, makeOwnerAlerts(tenantPrisma));
  const visits = new VisitsService(tenantPrisma, auditLog);
  const sync = new SyncService(tenantPrisma, sales, payments, visits, customers, new ConfigService({ SYNC_PUSH_MAX_BATCH: 20 }));
  const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-lockorder-${Date.now()}`, name: 'Lock Order Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Lock Order Co' } })).id;
    const mk = async (phone: string, roles: string[], permissions: string[]): Promise<AuthenticatedUser> => {
      const u = await systemPrisma.user.create({ data: { companyId, firstName: 'U', lastName: phone, phone } });
      await grantRole(companyId, u.id, roles[0]!, permissions); // push re-reads permissions per document (§8.4)
      return { id: u.id, companyId, firstName: 'U', lastName: phone, roles, permissions };
    };
    agent = await mk(`+99890${Date.now() % 10000000}`.slice(0, 13), ['SALES_AGENT'], ['orders.create', 'payments.create', 'field.create']);
    director = await mk(`+99891${Date.now() % 10000000}`.slice(0, 13), ['SALES_DIRECTOR'], ['orders.create', 'orders.update', 'orders.confirm', 'orders.deliver', 'payments.create']);

    const courier = await systemPrisma.user.create({
      data: { companyId, firstName: 'C', lastName: 'Courier', phone: `+99892${Date.now() % 10000000}`.slice(0, 13), telegramId: BigInt(Date.now()) },
    });
    await grantRole(companyId, courier.id, 'COURIER', []);
    courierId = courier.id;

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
        sync.push([orderDoc(0), paymentDoc(0), orderDoc(1)], agent),
        sync.push([paymentDoc(1), orderDoc(0, true), paymentDoc(0)], agent),
        sync.push([orderDoc(2), paymentDoc(2)], agent),
        sync.push([paymentDoc(2), orderDoc(2, true)], agent),
        // POST /orders (online) on the same customer.
        run(() => sales.create(orderPayload(0), director)),
        run(() => sales.create(orderPayload(0, true), director)),
        run(() => sales.create(orderPayload(1), director)),
        // courier known up front: INSERT -> StockLevel reservation -> SO counter (late).
        run(() => sales.create({ ...orderPayload(0), courierId }, director)),
        run(() => sales.create({ ...orderPayload(2, true), courierId }, director)),
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
    const res = await sync.push(docs, agent);
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
      const res = await sync.push(docs, agent);
      console.info(`[PERF] sync push 20 ${kind}: ${Math.round(performance.now() - t0)} ms`);
      expect(res.results.map((r) => r.status).filter((s) => s !== 'ACCEPTED')).toEqual([]);
    }
  }, 30_000);

  const SO_RE = /^SO-\d{4}-\d{6}$/;
  const soSeq = (n: string) => Number(n.split('-')[2]);
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };
  const expectSoGapless = async () => {
    const counter = await run(() => tenantPrisma.client.documentCounter.findFirst({ where: { docType: 'SO' } }));
    const rows = await run(() => tenantPrisma.client.salesOrder.findMany({ select: { number: true } }));
    expect(rows.filter((r) => !SO_RE.test(r.number))).toEqual([]);
    expect(rows.map((r) => soSeq(r.number)).sort((a, b) => a - b)).toEqual(Array.from({ length: counter!.lastNumber }, (_, i) => i + 1));
  };

  it('SO late counter: 24 parallel creates (courier / plain / sync) + rollbacks after the counter -> unique gapless numbers, no TMP- in responses, audit, notifications, replays', async () => {
    const notified: string[] = [];
    const spy = vi.spyOn(notifications, 'notifyCourierOrderAssigned').mockImplementation(async (_t, n) => {
      notified.push(n.orderNumber);
    });
    try {
      const replayClientId = randomUUID();
      const ops = Array.from({ length: 24 }, (_, i): Promise<unknown> => {
        const dto = { ...orderPayload(i % 3, i % 2 === 1), ...(i % 2 === 0 ? { courierId } : {}) };
        if (i % 6 === 4) {
          // Rolled back AFTER the counter was taken (create returned): its increment must roll back too.
          return run(async () => {
            await sales.create(dto, director);
            throw new Error('ROLLBACK_AFTER_COUNTER');
          });
        }
        if (i % 4 === 3) return sync.push([orderDoc(i % 3, true)], agent);
        if (i === 0) return run(() => sales.create({ ...dto, clientId: replayClientId }, director));
        return run(() => sales.create(dto, director));
      });
      const settled = await Promise.allSettled(ops);

      const errors = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => (s.reason as Error).message.slice(0, 200));
      expect(errors.filter((m) => m !== 'ROLLBACK_AFTER_COUNTER')).toEqual([]);
      expect(errors).toHaveLength(4);

      const values = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
      const created = values.filter((v): v is { number: string } => typeof (v as { number?: unknown }).number === 'string');
      expect(created.filter((o) => !SO_RE.test(o.number))).toEqual([]);
      expect(new Set(created.map((o) => o.number)).size).toBe(created.length);
      const pushed = values.flatMap((v) => (v as { results?: Array<{ status: string }> }).results ?? []);
      expect(pushed.map((r) => r.status).filter((st) => st !== 'ACCEPTED')).toEqual([]);

      // Idempotent replay (fast path) returns the final number, never the placeholder.
      const first = created.find((o) => (o as { clientId?: string | null }).clientId === replayClientId)!;
      const replay = await run(() => sales.createWithOutcome({ ...orderPayload(0), clientId: replayClientId }, director));
      expect(replay.created).toBe(false);
      expect(replay.order.number).toBe(first.number);

      const audits = await run(() => tenantPrisma.client.auditLog.findMany({ where: { action: 'order.create' }, select: { newValue: true } }));
      expect(audits.map((a) => String((a.newValue as { number?: unknown }).number)).filter((n) => !SO_RE.test(n))).toEqual([]);
      // 12 courier creates (even i), 4 rolled back after the counter (no notification), 8 notified with final numbers.
      expect(notified).toHaveLength(8);
      expect(notified.filter((n) => !SO_RE.test(n))).toEqual([]);
      await expectSoGapless();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('SO counter is taken after the reservation: a courier create blocked on StockLevel does not block a plain create', async () => {
    const held = gate();
    const release = gate();
    const holder = run(async () => {
      await tenantPrisma.client.$queryRaw`SELECT 1 FROM "StockLevel" WHERE "productId" = ${productIds[0]}::uuid AND "warehouseId" = ${warehouseId}::uuid FOR UPDATE`;
      held.open();
      await release.p;
    });
    await held.p;
    const blocked = run(() => sales.create({ ...orderPayload(1), courierId }, director));
    await new Promise((r) => setTimeout(r, 300)); // courier create is now parked on StockLevel
    try {
      const t0 = performance.now();
      // Old order (counter before INSERT/reserve) parks this behind the blocked create -> 55P03 after 2 s.
      const plain = await run(() => sales.create(orderPayload(2), director));
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(plain.number).toMatch(SO_RE);
      release.open();
      await holder;
      const courierOrder = await blocked;
      expect(soSeq(courierOrder.number)).toBe(soSeq(plain.number) + 1);
    } finally {
      release.open();
      await Promise.allSettled([holder, blocked]);
    }
    await expectSoGapless();
  }, 30_000);

  it('lock wait > 2 s fails fast as 55P03: sync push -> RETRY, POST /orders -> 503 SERVICE_BUSY, nothing written', async () => {
    const held = gate();
    const release = gate();
    const holder = tenantPrisma.run(
      companyId,
      async () => {
        await tenantPrisma.client.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerIds[0]}::uuid FOR UPDATE`;
        held.open();
        await release.p;
      },
      { timeout: 15_000 },
    );
    await held.p;
    const doc = orderDoc(0);
    const t0 = performance.now();
    try {
      const [pushRes, createRes] = await Promise.allSettled([sync.push([doc], agent), run(() => sales.create(orderPayload(0), director))]);
      expect(performance.now() - t0).toBeLessThan(4500); // before the 5 s tx timeout

      expect(pushRes.status).toBe('fulfilled');
      const item = (pushRes as PromiseFulfilledResult<{ results: Array<{ status: string; error?: { code: string } }> }>).value.results[0]!;
      expect(item.status).toBe('RETRY');
      expect(item.error?.code).toBe('SYNC_RETRY');

      expect(createRes.status).toBe('rejected');
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const setHeader = vi.fn();
      const host = { switchToHttp: () => ({ getResponse: () => ({ status, setHeader }) }) } as unknown as ArgumentsHost;
      new AllExceptionsFilter().catch((createRes as PromiseRejectedResult).reason, host);
      expect(status).toHaveBeenCalledWith(503);
      expect(json.mock.calls[0]![0].code).toBe('SERVICE_BUSY');
    } finally {
      release.open();
      await holder;
    }
    expect(await run(() => tenantPrisma.client.salesOrder.count({ where: { clientId: doc.clientId } }))).toBe(0);
    await expectSoGapless();
  }, 30_000);
  // ADR-061c: remove() holds Customer FOR UPDATE; order create takes FOR KEY SHARE and payment create FOR UPDATE on the
  // same row first. Either side may win, never both, never a deadlock.
  const errCode = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? ((r.reason as { response?: { code?: string } }).response?.code ?? String(r.reason)) : 'OK');
  const freshCustomer = async (label: string) =>
    run(async () => {
      const c = await tenantPrisma.client.customer.create({ data: { companyId, code: `LO-DEL-${label}-${randomUUID().slice(0, 6)}`, name: `LO del ${label}` } });
      const o = await tenantPrisma.client.outlet.create({ data: { companyId, customerId: c.id, name: `LO del O ${label}` } });
      return { customerId: c.id, outletId: o.id };
    });

  it('ADR-061c: concurrent delete vs order create — exactly one wins, no bypass, no deadlock', async () => {
    for (let i = 0; i < 6; i++) {
      const { customerId, outletId } = await freshCustomer(`o${i}`);
      const lines = productIds.map((productId, k) => ({ productId, packagingId: packagingIds[k]!, qty: 1 }));
      const ops = [run(() => customers.remove(customerId, director)), run(() => sales.create({ customerId, outletId, warehouseId, lines }, director))];
      const [del, create] = await Promise.allSettled(i % 2 ? ops.reverse() : ops).then((r) => (i % 2 ? r.reverse() : r));
      expect([errCode(del!), errCode(create!)].filter((c) => /deadlock|40P01|P2034/i.test(c))).toEqual([]);
      if (errCode(del!) === 'OK') expect(errCode(create!)).toBe('CUSTOMER_NOT_FOUND');
      else expect([errCode(del!), errCode(create!)]).toEqual(['CUSTOMER_HAS_OPEN_OBLIGATIONS', 'OK']);
      const [row, orders] = await run(() => Promise.all([tenantPrisma.client.customer.findUniqueOrThrow({ where: { id: customerId } }), tenantPrisma.client.salesOrder.count({ where: { customerId } })]));
      expect(row.deletedAt !== null && orders > 0).toBe(false); // never a deleted customer with an order
    }
  }, 60_000);

  it('ADR-061c: concurrent delete vs payment post — exactly one wins, no bypass, no deadlock', async () => {
    for (let i = 0; i < 6; i++) {
      const { customerId } = await freshCustomer(`p${i}`);
      const ops = [run(() => customers.remove(customerId, director)), run(() => payments.create({ customerId, amount: '500', method: 'CASH' } as never, director))];
      const [del, pay] = await Promise.allSettled(i % 2 ? ops.reverse() : ops).then((r) => (i % 2 ? r.reverse() : r));
      if (errCode(del!) === 'OK') expect(errCode(pay!)).toBe('CUSTOMER_NOT_FOUND');
      else expect([errCode(del!), errCode(pay!)]).toEqual(['CUSTOMER_HAS_CREDIT_BALANCE', 'OK']);
      const [row, paid] = await run(() => Promise.all([tenantPrisma.client.customer.findUniqueOrThrow({ where: { id: customerId } }), tenantPrisma.client.payment.count({ where: { customerId } })]));
      expect(row.deletedAt !== null && paid > 0).toBe(false);
    }
  }, 60_000);
});
