import { randomUUID } from 'node:crypto';
import type { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, systemPrisma, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { installBigIntJson } from '../../common/serialization/bigint-json';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StockService } from '../stock/stock.service';
import { InvalidOrderTransitionException } from './sales-exceptions';
import { SalesService } from './sales.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Just past the default 5000 ms interactive tx timeout; the timeout itself stays the production default. */
const PAST_TX_TIMEOUT_MS = 5_200;

/**
 * F7.6c load finding: POST /orders/:id/deliver -> P2028 "Transaction already
 * closed". Real Postgres + RLS + the real default timeout: a timed-out deliver
 * must leave no trace, and retrying it must issue stock and invoice exactly once.
 */
describe('deliver: interactive tx timeout (real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let customerId: string;
  let p1: { productId: string; packagingId: string };
  let p2: { productId: string; packagingId: string };

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, new DocumentNumberingService(), notifications);
  const idempotency = new IdempotencyInterceptor();

  const run = <T>(fn: (tx: TenantClient) => Promise<T>) => tenantPrisma.run(companyId, fn);

  async function makeProduct(sku: string) {
    const res = await run(async (tx) => {
      const product = await tx.product.create({ data: { companyId, sku, name: sku, baseUnit: 'dona', vatRate: 12 } });
      const packaging = await tx.productPackaging.create({
        data: { productId: product.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true },
      });
      const priceList = await tx.priceList.findFirstOrThrow({ where: { isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: product.id, price: '10000' } });
      return { productId: product.id, packagingId: packaging.id };
    });
    await run(() => stock.receive({ productId: res.productId, warehouseId, qty: 100 }, user));
    return res;
  }

  beforeAll(async () => {
    installBigIntJson(); // main.ts does this at bootstrap
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-deltimeout-${Date.now()}`, name: 'Deliver Timeout' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Deliver Timeout Co' } });
    companyId = company.id;
    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Op', lastName: 'Timeout', phone: `+9989002${Math.floor(Math.random() * 90000) + 10000}` },
    });
    user = { id: dbUser.id, companyId, firstName: 'Op', lastName: 'Timeout', roles: ['WAREHOUSE'], permissions: ['orders.update'] };
    await run(async (tx) => {
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'Timeout WH' } })).id;
      await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
    });
    p1 = await makeProduct('TO-1');
    p2 = await makeProduct('TO-2');
    const { customer } = await run(() => customers.create({ code: `TO-${Date.now()}`, name: 'Timeout Customer' }, user));
    customerId = (customer as { id: string }).id;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function confirmedOrder() {
    const order = await run(() =>
      sales.create(
        {
          customerId,
          lines: [p1, p2].map((p) => ({ productId: p.productId, packagingId: p.packagingId, qty: 3 })),
        },
        user,
      ),
    );
    await run(() => sales.confirm(order.id, user));
    return order;
  }

  /** Everything deliver can touch, as comparable strings. */
  async function snapshot(orderId: string) {
    return run(async (tx) => {
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { orderBy: { id: 'asc' } } } });
      const levels = await tx.stockLevel.findMany({ where: { warehouseId }, orderBy: { productId: 'asc' } });
      const cust = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      const counter = await tx.documentCounter.findFirst({ where: { companyId, docType: 'INV' } });
      return {
        status: order.status,
        deliveredQty: order.lines.map((l) => l.deliveredQty?.toString() ?? null),
        levels: levels.map((l) => `${l.onHand.toString()}/${l.reserved.toString()}`),
        cachedBalance: cust.cachedBalance.toString(),
        invCounter: counter?.lastNumber ?? 0,
        invoices: await tx.invoice.count({ where: { orderId } }),
        issues: await tx.stockMovement.count({ where: { refId: orderId, type: 'ISSUE' } }),
        movements: await tx.stockMovement.count({ where: { refId: orderId } }),
        audits: await tx.auditLog.count({ where: { entityId: orderId, action: 'order.deliver' } }),
        outbox: await tx.outboxEvent.count({ where: { companyId } }),
        idempotency: await tx.idempotencyRecord.count({ where: { companyId } }),
      };
    });
  }

  /** Exact request tx shape: tenant tx -> IdempotencyInterceptor -> handler. */
  function requestContext(orderId: string, key: string) {
    const req = { headers: { 'idempotency-key': key }, method: 'POST', originalUrl: `/orders/${orderId}/deliver`, body: {}, user };
    return {
      getHandler: () => function deliver() {},
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ status: vi.fn() }) }),
    } as unknown as ExecutionContext;
  }

  function deliverRequest(orderId: string, key: string, after?: () => Promise<unknown>) {
    const ctx = requestContext(orderId, key);
    return run(async () => {
      const next: CallHandler = { handle: () => from(sales.deliver(orderId, user)) };
      const res = await lastValueFrom(idempotency.intercept(ctx, next) as Observable<unknown>);
      await after?.();
      return res;
    });
  }

  function mapped(err: unknown) {
    const json = vi.fn();
    const status = vi.fn((_code: number) => ({ json }));
    const setHeader = vi.fn();
    const host = { switchToHttp: () => ({ getResponse: () => ({ status, setHeader }) }) } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(err, host);
    return { status: status.mock.calls[0]![0], body: json.mock.calls[0]![0], setHeader };
  }

  it('commit on the expired tx (log shape): full rollback, afterCommit silent, retry with the same key issues once', async () => {
    const order = await confirmedOrder();
    const before = await snapshot(order.id);
    const onCommit = vi.fn();
    const key = randomUUID();

    const failed = await deliverRequest(order.id, key, async () => {
      TenantContext.afterCommit(onCommit);
      await sleep(PAST_TX_TIMEOUT_MS);
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect((failed as { code?: string }).code).toBe('P2028');
    expect((failed as Error).message).toMatch(/Transaction already closed.*commit cannot be executed on an expired transaction/s);
    expect(onCommit).not.toHaveBeenCalled();
    expect(await snapshot(order.id)).toEqual(before);

    const http = mapped(failed);
    expect(http.status).toBe(503);
    expect(http.body.code).toBe('SERVICE_BUSY');
    expect(Object.keys(http.body.message).sort()).toEqual(['en', 'ru', 'uz']);
    expect(http.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));

    const first = (await deliverRequest(order.id, key)) as { status: string };
    expect(first.status).toBe('DELIVERED');
    const after = await snapshot(order.id);
    expect(after).toMatchObject({ status: 'DELIVERED', invoices: 1, issues: 2, audits: 1, invCounter: before.invCounter + 1 });

    // Lost-response retry: same key replays, nothing is written twice.
    await deliverRequest(order.id, key);
    expect(await snapshot(order.id)).toEqual(after);
  }, 30_000);

  it('expiry mid-deliver (first line issued, second not): full rollback, retry succeeds once', async () => {
    const order = await confirmedOrder();
    const before = await snapshot(order.id);
    const realIssue = stock.issue.bind(stock);
    const issue = vi.spyOn(stock, 'issue').mockImplementationOnce(async (...args: Parameters<StockService['issue']>) => {
      const res = await realIssue(...args);
      await sleep(PAST_TX_TIMEOUT_MS);
      return res;
    });

    const failed = await run(() => sales.deliver(order.id, user)).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect((failed as { code?: string }).code).toBe('P2028');
    expect((failed as Error).message).toMatch(/expired transaction/);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(await snapshot(order.id)).toEqual(before);
    expect(mapped(failed).body.code).toBe('SERVICE_BUSY');

    vi.restoreAllMocks();
    await run(() => sales.deliver(order.id, user));
    expect(await snapshot(order.id)).toMatchObject({ status: 'DELIVERED', invoices: 1, issues: 2, audits: 1, invCounter: before.invCounter + 1 });
  }, 30_000);

  it('two parallel retries after a timeout: one delivers, the other is refused, stock and invoice once', async () => {
    const order = await confirmedOrder();
    const before = await snapshot(order.id);
    await run(async () => {
      await sales.deliver(order.id, user);
      await sleep(PAST_TX_TIMEOUT_MS);
    }).catch(() => undefined);
    expect(await snapshot(order.id)).toEqual(before);

    const results = await Promise.allSettled([0, 1].map(() => run(() => sales.deliver(order.id, user))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(InvalidOrderTransitionException);
    expect(await snapshot(order.id)).toMatchObject({ status: 'DELIVERED', invoices: 1, issues: 2, audits: 1, invCounter: before.invCounter + 1 });
  }, 30_000);
});
