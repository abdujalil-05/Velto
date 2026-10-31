import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { installBigIntJson } from '../../common/serialization/bigint-json';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsController } from '../finance/payments/payments.controller';
import { PaymentsService } from '../finance/payments/payments.service';
import { StockService } from '../stock/stock.service';
import {
  NOTIFICATION_DELIVERY_QUEUE,
  TELEGRAM_LEASE_MS,
  TELEGRAM_MAX_ATTEMPTS,
  type NotificationDeliveryJobData,
} from './notification-delivery.constants';
import { NotificationDeliveryProcessor } from './notification-delivery.processor';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDeliverySweepService } from './notification-delivery-sweep.service';
import { NotificationsService } from './notifications.service';
import { OwnerAlertsService } from './owner-alerts';

installBigIntJson();

/**
 * ADR-060/060a delivery pipeline against REAL Redis/BullMQ + real Postgres/RLS; only `fetch` (Telegram) is mocked.
 * Unique queue prefix per test, cleanup only of our own prefix. Sweeps are cross-tenant by design, so the test
 * worker ignores jobs of companies that are not this file's (parallel test files share the DB).
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const basePrefix = `adr060-${randomUUID().slice(0, 8)}`;
let prefix = basePrefix;
let reachable = false;

async function redisReachable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });
  r.on('error', () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error('until: timeout');
}
const phone = () => `+99896${Math.floor(1e6 + Math.random() * 8e6)}`;

describe('ADR-060 Telegram delivery (real Redis/BullMQ + Postgres)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const config = { get: () => 'TEST-BOT-TOKEN' } as unknown as ConfigService;
  const delivery = new NotificationDeliveryService(tenantPrisma, config);
  const processor = new NotificationDeliveryProcessor(delivery);
  const conns: Redis[] = [];
  const queues: Queue[] = [];
  const workers: Worker[] = [];

  type Co = { companyId: string; actor: AuthenticatedUser; ownerTg: bigint; ownerId: string; productId: string; warehouseId: string; name: string };
  let A: Co;
  let B: Co;
  const mine = new Set<string>();
  let calls: { chat: string; text: string }[] = [];
  let fetchImpl: (chat: string, text: string) => Promise<unknown>;
  let tgSeq = 0;
  const tgBase = BigInt(Date.now()) * 1000n;

  const mkConn = (url = REDIS_URL) => {
    const c = new Redis(url, { maxRetriesPerRequest: null, retryStrategy: url === REDIS_URL ? undefined : () => 200 });
    c.on('error', () => undefined);
    conns.push(c);
    return c;
  };
  const mkQueue = (url = REDIS_URL) => {
    const q = new Queue<NotificationDeliveryJobData>(NOTIFICATION_DELIVERY_QUEUE, { connection: mkConn(url), prefix });
    q.on('error', () => undefined);
    queues.push(q);
    return q;
  };
  const mkWorker = (opts: { concurrency?: number; stalledInterval?: number } = {}) => {
    const w = new Worker<NotificationDeliveryJobData>(
      NOTIFICATION_DELIVERY_QUEUE,
      async (job: Job<NotificationDeliveryJobData>) => {
        if (!mine.has(job.data.companyId)) return; // another test file's row: leave untouched
        await processor.process(job);
      },
      { connection: mkConn(), prefix, concurrency: opts.concurrency ?? 5, lockDuration: 1500, stalledInterval: opts.stalledInterval ?? 1000, maxStalledCount: 3 },
    );
    w.on('error', () => undefined);
    workers.push(w);
    return w;
  };
  const row = (id: string) => systemPrisma.notification.findUniqueOrThrow({ where: { id } });
  const callsFor = (needle: string) => calls.filter((c) => c.text.includes(needle));
  const svcFor = (q: Queue) => {
    const notifications = new NotificationsService(tenantPrisma, config, q as unknown as Queue<NotificationDeliveryJobData>);
    const alerts = new OwnerAlertsService(notifications);
    const stock = new StockService(tenantPrisma, auditLog, alerts);
    const customers = new CustomersService(tenantPrisma, auditLog);
    const payments = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService(), alerts);
    return { stock, customers, payments };
  };

  async function mkCompany(label: string): Promise<Co> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-ndr-${label}-${randomUUID().slice(0, 8)}`, name: `NDR ${label}` } });
    const companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `NDR Co ${label}` } })).id;
    const ownerRole = await systemPrisma.role.create({ data: { companyId, name: 'Owner', code: 'OWNER', isSystem: true } });
    const ownerTg = tgBase + BigInt(++tgSeq);
    const owner = await systemPrisma.user.create({ data: { companyId, firstName: `Own${label}`, lastName: 'Q', phone: phone(), telegramId: ownerTg } });
    await systemPrisma.userRole.create({ data: { userId: owner.id, roleId: ownerRole.id } });
    const a = await systemPrisma.user.create({ data: { companyId, firstName: 'Act', lastName: label, phone: phone() } });
    const name = `Prod-${label}-${randomUUID().slice(0, 6)}`;
    const productId = (await systemPrisma.product.create({ data: { companyId, sku: `NDR-${label}-${randomUUID().slice(0, 6)}`, name, baseUnit: 'dona' } })).id;
    const warehouseId = (await systemPrisma.warehouse.create({ data: { companyId, name: `WH-${label}` } })).id;
    mine.add(companyId);
    return { companyId, ownerTg, ownerId: owner.id, productId, warehouseId, name, actor: { id: a.id, companyId, firstName: 'Act', lastName: label, roles: ['OWNER'], permissions: [] } };
  }

  beforeAll(async () => {
    reachable = await redisReachable();
    if (!reachable) console.warn(`[notification-delivery-redis] SKIPPED: Redis unreachable at ${REDIS_URL}`);
    A = await mkCompany('A');
    B = await mkCompany('B');
  });
  let n = 0;
  beforeEach(() => {
    prefix = `${basePrefix}-${n++}`;
    calls = [];
    fetchImpl = async () => ({ ok: true, status: 200, body: null });
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { chat_id: string; text: string };
      calls.push({ chat: b.chat_id, text: b.text });
      return fetchImpl(b.chat_id, b.text);
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.QUEUE_ENQUEUE_TIMEOUT_MS;
    await Promise.all(workers.splice(0).map((w) => w.close(true).catch(() => undefined)));
  });
  afterAll(async () => {
    await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
    if (reachable) {
      const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
      try {
        let cursor = '0';
        do {
          const [next, keys] = await r.scan(cursor, 'MATCH', `${basePrefix}-*`, 'COUNT', 500);
          cursor = next;
          if (keys.length) await r.del(...keys);
        } while (cursor !== '0');
      } finally {
        r.disconnect();
      }
    }
    conns.forEach((c) => c.disconnect());
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  /** Skips (loudly, see warning above) only when Redis is unreachable; asserts are never weakened. */
  const t = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(name, async (ctx) => {
      if (!reachable) return ctx.skip();
      await fn();
    }, timeout);

  async function insertPending(co: Co, marker: string, over: { status?: 'PENDING' | 'SENDING'; claimedAt?: Date; attempts?: number } = {}) {
    return systemPrisma.notification.create({
      data: {
        companyId: co.companyId,
        recipientId: co.ownerId,
        type: 'test.ndr',
        title: { uz: marker, ru: marker, en: marker },
        message: { uz: 'x', ru: 'x', en: 'x' },
        telegramStatus: over.status ?? 'PENDING',
        telegramClaimedAt: over.claimedAt,
        telegramAttempts: over.attempts ?? 0,
      },
    });
  }

  t('1. Redis unreachable at commit: stock adjust committed, row PENDING; later sweep + real worker -> SENT, exactly 1 fetch', async () => {
    process.env.QUEUE_ENQUEUE_TIMEOUT_MS = '300';
    const dead = mkQueue('redis://localhost:1'); // nothing listens on port 1
    const { stock } = svcFor(dead);
    const note = `redis-down-${randomUUID().slice(0, 6)}`;
    await tenantPrisma.run(A.companyId, () => stock.adjust({ productId: A.productId, warehouseId: A.warehouseId, qty: 3, reason: note }, A.actor));
    const mv = await systemPrisma.stockMovement.findFirstOrThrow({ where: { companyId: A.companyId, note } });
    const rows = await systemPrisma.notification.findMany({ where: { dedupKey: `stock.adjust:${mv.id}` } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ telegramStatus: 'PENDING', companyId: A.companyId, recipientId: A.ownerId });
    expect(calls).toHaveLength(0);

    const live = mkQueue();
    mkWorker();
    await new NotificationDeliverySweepService(live).sweep();
    await until(async () => (await row(rows[0]!.id)).telegramStatus === 'SENT');
    const done = await row(rows[0]!.id);
    expect(done).toMatchObject({ telegramStatus: 'SENT', telegramAttempts: 1, telegramLastError: null });
    expect(callsFor(note)).toHaveLength(1);
    expect(calls[0]!.chat).toBe(A.ownerTg.toString());
  });

  t('2. two real Workers (concurrency 5) + 4 concurrent sweeps on the same rows -> each row sent once, no duplicate rows', async () => {
    const q = mkQueue();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await insertPending(A, `RACE-${prefix}-${i}`)).id);
    const total0 = await systemPrisma.notification.count({ where: { companyId: A.companyId } });
    fetchImpl = async () => {
      await sleep(40);
      return { ok: true, status: 200, body: null };
    };
    mkWorker({ concurrency: 5 });
    mkWorker({ concurrency: 5 });
    await Promise.all([1, 2, 3, 4].map(() => new NotificationDeliverySweepService(q).sweep()));
    await until(async () => (await systemPrisma.notification.count({ where: { id: { in: ids }, telegramStatus: 'SENT' } })) === ids.length);
    // late re-deliveries of replaced terminal jobs must stay no-ops: sweep again and give workers time
    await new NotificationDeliverySweepService(q).sweep();
    await sleep(800);
    for (let i = 0; i < ids.length; i++) expect(callsFor(`RACE-${prefix}-${i}\n`), `row ${i}`).toHaveLength(1);
    const after = await systemPrisma.notification.findMany({ where: { id: { in: ids } } });
    expect(after.every((r) => r.telegramStatus === 'SENT' && r.telegramAttempts === 1)).toBe(true);
    expect(await systemPrisma.notification.count({ where: { companyId: A.companyId } })).toBe(total0);
  });

  t('3. worker killed mid-send: lease expiry + stalled job recovered by another worker -> SENT; at-least-once (2 fetches); lost job recovered by sweep', async () => {
    const q = mkQueue();
    const marker = `KILL-${prefix}`;
    const stalled = await insertPending(A, `${marker}-stalled`);
    let first = true;
    fetchImpl = (_c, text) => {
      if (text.includes(`${marker}-stalled`) && first) {
        first = false;
        return new Promise(() => undefined); // the "crash": send never completes
      }
      return Promise.resolve({ ok: true, status: 200, body: null });
    };
    const w1 = mkWorker({ concurrency: 1 });
    await new NotificationDeliverySweepService(q).sweep();
    await until(async () => callsFor(`${marker}-stalled`).length === 1);
    expect((await row(stalled.id)).telegramStatus).toBe('SENDING');
    await w1.close(true); // kill: job stays active in Redis, row stays SENDING
    workers.splice(workers.indexOf(w1), 1);
    // time passes: the lease (5 min) expires
    await systemPrisma.notification.update({ where: { id: stalled.id }, data: { telegramClaimedAt: new Date(Date.now() - TELEGRAM_LEASE_MS - 5_000) } });

    // second case: the BullMQ job is lost entirely (no job for this row) while the row is SENDING with an expired lease
    const lost = await insertPending(A, `${marker}-lost`, { status: 'SENDING', claimedAt: new Date(Date.now() - TELEGRAM_LEASE_MS - 5_000), attempts: 1 });

    mkWorker({ concurrency: 2, stalledInterval: 500 });
    await new NotificationDeliverySweepService(q).sweep(); // lost row enqueued; the stalled row's job is still 'active' -> BullMQ stalled check re-queues it
    await until(async () => (await row(stalled.id)).telegramStatus === 'SENT' && (await row(lost.id)).telegramStatus === 'SENT', 30_000);
    expect(await row(stalled.id)).toMatchObject({ telegramAttempts: 2, telegramLastError: null });
    expect(callsFor(`${marker}-stalled`)).toHaveLength(2); // documented at-least-once: crash after send => duplicate
    expect(callsFor(`${marker}-lost`)).toHaveLength(1);
    expect((await row(lost.id)).telegramAttempts).toBe(2);
  });

  t('4. Telegram 500 persistent: op stays committed, attempts bounded at the limit, FAILED with lastError code, no infinite loop', async () => {
    const q = mkQueue();
    const { stock } = svcFor(q);
    const note = `tg500-${randomUUID().slice(0, 6)}`;
    fetchImpl = async () => ({ ok: false, status: 500, body: null });
    mkWorker();
    await tenantPrisma.run(A.companyId, () => stock.adjust({ productId: A.productId, warehouseId: A.warehouseId, qty: -1, reason: note }, A.actor));
    const mv = await systemPrisma.stockMovement.findFirstOrThrow({ where: { companyId: A.companyId, note } });
    const nid = (await systemPrisma.notification.findFirstOrThrow({ where: { dedupKey: `stock.adjust:${mv.id}`, recipientId: A.ownerId } })).id;
    const sweeper = new NotificationDeliverySweepService(q);
    const end = Date.now() + 40_000;
    while (Date.now() < end && (await row(nid)).telegramStatus !== 'FAILED') {
      // simulate backoff elapsing (real backoff is 30 s .. 1 h)
      await systemPrisma.notification.updateMany({ where: { id: nid, telegramStatus: 'PENDING' }, data: { telegramNextAttemptAt: new Date(Date.now() - 1000) } });
      await sweeper.sweep();
      await sleep(150);
    }
    const failed = await row(nid);
    expect(failed).toMatchObject({ telegramStatus: 'FAILED', telegramAttempts: TELEGRAM_MAX_ATTEMPTS, telegramLastError: 'HTTP_500', telegramNextAttemptAt: null });
    expect(callsFor(note)).toHaveLength(TELEGRAM_MAX_ATTEMPTS);
    // terminal: more sweeps neither enqueue it nor send again
    await sweeper.sweep();
    await sleep(600);
    expect(callsFor(note)).toHaveLength(TELEGRAM_MAX_ATTEMPTS);
    expect(await systemPrisma.stockMovement.count({ where: { id: mv.id } })).toBe(1);
  });

  t('5. two companies: rows never go to the other company owner; companyId preserved; wrong-company job is a no-op (RLS)', async () => {
    const q = mkQueue();
    const { stock: stockA } = svcFor(q);
    const noteA = `iso-A-${randomUUID().slice(0, 6)}`;
    const noteB = `iso-B-${randomUUID().slice(0, 6)}`;
    await Promise.all([
      tenantPrisma.run(A.companyId, () => stockA.adjust({ productId: A.productId, warehouseId: A.warehouseId, qty: 2, reason: noteA }, A.actor)),
      tenantPrisma.run(B.companyId, () => stockA.adjust({ productId: B.productId, warehouseId: B.warehouseId, qty: 2, reason: noteB }, B.actor)),
    ]);
    const rowOf = async (co: Co, note: string) => {
      const mv = await systemPrisma.stockMovement.findFirstOrThrow({ where: { companyId: co.companyId, note } });
      return systemPrisma.notification.findFirstOrThrow({ where: { dedupKey: `stock.adjust:${mv.id}` } });
    };
    const ra = await rowOf(A, noteA);
    const rb = await rowOf(B, noteB);
    expect(ra).toMatchObject({ companyId: A.companyId, recipientId: A.ownerId });
    expect(rb).toMatchObject({ companyId: B.companyId, recipientId: B.ownerId });

    // forged job: A's notification id under B's companyId must not send or change anything
    await delivery.deliver(B.companyId, ra.id);
    expect(calls).toHaveLength(0);
    expect((await row(ra.id)).telegramStatus).toBe('PENDING');

    mkWorker();
    await new NotificationDeliverySweepService(q).sweep();
    await until(async () => (await row(ra.id)).telegramStatus === 'SENT' && (await row(rb.id)).telegramStatus === 'SENT');
    expect(callsFor(noteA).map((c) => c.chat)).toEqual([A.ownerTg.toString()]);
    expect(callsFor(noteB).map((c) => c.chat)).toEqual([B.ownerTg.toString()]);
    expect(callsFor(A.name).every((c) => c.chat === A.ownerTg.toString())).toBe(true);
    expect(callsFor(B.name).every((c) => c.chat === B.ownerTg.toString())).toBe(true);
    expect(await row(ra.id)).toMatchObject({ companyId: A.companyId });
    expect(await row(rb.id)).toMatchObject({ companyId: B.companyId });
  });

  t('6a. payment reverse with the same Idempotency-Key twice -> one reversal, one notification set', async () => {
    const q = mkQueue();
    const { customers, payments } = svcFor(q);
    const { customer } = await tenantPrisma.run(A.companyId, () => customers.create({ code: `NDR-${randomUUID().slice(0, 8)}`, name: 'Idem Customer' }, A.actor));
    const customerId = (customer as { id: string }).id;
    const p = await tenantPrisma.run(A.companyId, () => payments.create({ customerId, amount: 777000, method: 'TRANSFER' }, A.actor));
    expect(Reflect.getMetadata('__interceptors__', PaymentsController.prototype.reverse)).toContain(IdempotencyInterceptor);

    const interceptor = new IdempotencyInterceptor();
    const body = { reason: 'duplicate key test' };
    const key = `idem-${randomUUID()}`;
    const call = () => {
      const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; } };
      const req = { method: 'POST', originalUrl: `/payments/${p.id}/reverse`, headers: { 'idempotency-key': key }, body, user: A.actor };
      const ctx = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }), getHandler: () => PaymentsController.prototype.reverse } as unknown as ExecutionContext;
      return tenantPrisma.run(A.companyId, () =>
        new Promise<unknown>((resolve, reject) =>
          interceptor.intercept(ctx, { handle: () => ({ subscribe: (o: { next: (v: unknown) => void; error: (e: unknown) => void }) => void payments.reverse(p.id, body.reason, A.actor).then(o.next, o.error) }) as never }).subscribe({ next: resolve, error: reject }),
        ),
      );
    };
    await call();
    const notifCount = () => systemPrisma.notification.count({ where: { companyId: A.companyId, entityId: p.id, type: 'payment.reversed' } });
    const n1 = await notifCount();
    expect(n1).toBe(1);
    await call();
    expect(await systemPrisma.paymentReversal.count({ where: { reversesPaymentId: p.id } })).toBe(1);
    expect(await notifCount()).toBe(n1);
  });

  t('6b. stock RELEASE creates no OWNER alert (like RESERVE)', async () => {
    const q = mkQueue();
    const { stock } = svcFor(q);
    await tenantPrisma.run(A.companyId, () => stock.receive({ productId: A.productId, warehouseId: A.warehouseId, qty: 50 } as never, A.actor));
    const before = await systemPrisma.notification.count({ where: { companyId: A.companyId } });
    const refId = randomUUID();
    const params = { companyId: A.companyId, productId: A.productId, warehouseId: A.warehouseId, qty: 4, refType: 'SalesOrder', refId };
    await tenantPrisma.run(A.companyId, (tx) => stock.reserve(tx, params));
    await tenantPrisma.run(A.companyId, (tx) => stock.release(tx, params));
    expect(await systemPrisma.notification.count({ where: { companyId: A.companyId } })).toBe(before);
  });
});
