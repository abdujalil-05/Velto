import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma, type TenantClient } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AppException } from '../../common/errors/app-exception';
import {
  CustomerHasOpenObligationsException,
  CustomerHasOutstandingBalanceException,
} from '../customers/customers-exceptions';
import { CustomersService } from '../customers/customers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InsufficientStockException } from '../stock/stock-exceptions';
import { StockService } from '../stock/stock.service';
import { InvalidOrderTransitionException } from './sales-exceptions';
import { SalesService } from './sales.service';

/**
 * F2.4 / TZ §10.5 (+ §6.6 1 order = 1 invoice, §8.6 gapless INV numbering):
 * goods-issue (deliver, incl. partial) under real parallelism on real
 * Postgres + RLS. Own tenant, so counters/stock are exact (no shared state).
 */
describe('Goods issue races (F2.4, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let p1: { productId: string; packagingId: string };
  let p2: { productId: string; packagingId: string };

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog);
  const docNumbering = new DocumentNumberingService();
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, notifications);

  const run = <T>(fn: (tx: TenantClient) => Promise<T>) => tenantPrisma.run(companyId, fn);

  async function makeProduct(sku: string, onHand: number) {
    const res = await tenantPrisma.run(companyId, async (tx) => {
      const product = await tx.product.create({
        data: { companyId, sku, name: sku, baseUnit: 'dona', vatRate: 12 },
      });
      const packaging = await tx.productPackaging.create({
        data: { productId: product.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true },
      });
      const priceList = await tx.priceList.findFirstOrThrow({ where: { isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: product.id, price: '10000' } });
      return { productId: product.id, packagingId: packaging.id };
    });
    if (onHand > 0) await run(() => stock.receive({ productId: res.productId, warehouseId, qty: onHand }, user));
    return res;
  }

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-delrace-${Date.now()}`, name: 'Delivery Race Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Delivery Race Co' } });
    companyId = company.id;
    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Op', lastName: 'Race', phone: `+9989001${Math.floor(Math.random() * 90000) + 10000}` },
    });
    user = { id: dbUser.id, companyId, firstName: 'Op', lastName: 'Race', roles: ['WAREHOUSE'], permissions: ['orders.update'] };
    await tenantPrisma.run(companyId, async (tx) => {
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'Race WH' } })).id;
      await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
    });
    p1 = await makeProduct('RACE-1', 1000);
    p2 = await makeProduct('RACE-2', 1000);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function newCustomer() {
    const { customer } = await run(() =>
      customers.create({ code: `RACE-${Date.now()}-${Math.random()}`, name: 'Race Customer' }, user),
    );
    return (customer as { id: string }).id;
  }

  async function submitted(customerId: string, lines: { p: typeof p1; qty: number }[]) {
    return run(() =>
      sales.create(
        {
          customerId,
          lines: lines.map((l) => ({ productId: l.p.productId, packagingId: l.p.packagingId, qty: l.qty })),
        },
        user,
      ),
    );
  }

  async function confirmed(customerId: string, lines: { p: typeof p1; qty: number }[]) {
    const o = await submitted(customerId, lines);
    await run(() => sales.confirm(o.id, user));
    return o;
  }

  async function level(productId: string) {
    const l = await run((tx) =>
      tx.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId } } }),
    );
    return { onHand: l.onHand, reserved: l.reserved };
  }

  const onlyDomainErrors = (results: PromiseSettledResult<unknown>[]) => {
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AppException);
  };

  it('§10.5(1) two parallel deliver() of one order: one wins, one invoice, stock issued once', async () => {
    const customerId = await newCustomer();
    const o = await confirmed(customerId, [{ p: p1, qty: 5 }]);
    const before = await level(p1.productId);

    const results = await Promise.allSettled([0, 1].map(() => run(() => sales.deliver(o.id, user))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(rej.reason).toBeInstanceOf(InvalidOrderTransitionException);

    const [invoices, issues] = await run(async (tx) => [
      await tx.invoice.count({ where: { orderId: o.id } }),
      await tx.stockMovement.count({ where: { refId: o.id, type: 'ISSUE' } }),
    ]);
    expect(invoices).toBe(1);
    expect(issues).toBe(1);
    const after = await level(p1.productId);
    expect(before.onHand.minus(after.onHand).toString()).toBe('5');
    expect(before.reserved.minus(after.reserved).toString()).toBe('5');
  });

  it('§10.5(1) two parallel PARTIAL deliver() of one order: one wins, remainder released once', async () => {
    const customerId = await newCustomer();
    const o = await confirmed(customerId, [{ p: p1, qty: 10 }]);
    const before = await level(p1.productId);
    const body = { lines: [{ lineId: o.lines[0]!.id, deliveredQty: '4' }] };

    const results = await Promise.allSettled([0, 1].map(() => run(() => sales.deliver(o.id, user, body))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    onlyDomainErrors(results);

    const [invoices, issues, releases] = await run(async (tx) => [
      await tx.invoice.count({ where: { orderId: o.id } }),
      await tx.stockMovement.count({ where: { refId: o.id, type: 'ISSUE' } }),
      await tx.stockMovement.count({ where: { refId: o.id, type: 'RELEASE' } }),
    ]);
    expect([invoices, issues, releases]).toEqual([1, 1, 1]);
    const after = await level(p1.productId);
    expect(before.onHand.minus(after.onHand).toString()).toBe('4');
    expect(before.reserved.minus(after.reserved).toString()).toBe('10'); // 4 issued + 6 released
  });

  it('§10.5(2) last unit: two orders compete, exactly one is served, onHand never negative, reserved consistent', async () => {
    for (let round = 0; round < 3; round++) {
      const scarce = await makeProduct(`RACE-SCARCE-${round}-${Date.now()}`, 1);
      const [a, b] = await Promise.all([
        submitted(await newCustomer(), [{ p: scarce, qty: 1 }]),
        submitted(await newCustomer(), [{ p: scarce, qty: 1 }]),
      ]);
      // Contend at confirm (reservation) ...
      const conf = await Promise.allSettled([a, b].map((o) => run(() => sales.confirm(o.id, user))));
      onlyDomainErrors(conf);
      expect(conf.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((conf.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(
        InsufficientStockException,
      );
      // ... and at delivery: both deliver attempts, only the confirmed order may succeed.
      const del = await Promise.allSettled([a, b].map((o) => run(() => sales.deliver(o.id, user))));
      onlyDomainErrors(del);
      expect(del.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const l = await level(scarce.productId);
      expect(l.onHand.toString()).toBe('0');
      expect(l.reserved.toString()).toBe('0');
      const invoices = await run((tx) => tx.invoice.count({ where: { orderId: { in: [a.id, b.id] } } }));
      expect(invoices).toBe(1);
    }
  });

  it('§10.5(2) partial delivery releases a unit while another order confirms for it: outcome consistent either way', async () => {
    for (let round = 0; round < 3; round++) {
      const scarce = await makeProduct(`RACE-REL-${round}-${Date.now()}`, 2);
      const a = await confirmed(await newCustomer(), [{ p: scarce, qty: 2 }]);
      const b = await submitted(await newCustomer(), [{ p: scarce, qty: 1 }]);
      const body = { lines: [{ lineId: a.lines[0]!.id, deliveredQty: '1' }] };

      const [del, conf] = await Promise.allSettled([
        run(() => sales.deliver(a.id, user, body)),
        run(() => sales.confirm(b.id, user)),
      ]);
      onlyDomainErrors([del, conf]);
      expect(del.status).toBe('fulfilled');
      const l = await level(scarce.productId);
      expect(l.onHand.toString()).toBe('1');
      expect(l.onHand.greaterThanOrEqualTo(0)).toBe(true);
      expect(l.reserved.lessThanOrEqualTo(l.onHand)).toBe(true);
      // B confirmed => its unit is reserved; B refused => nothing reserved.
      if (conf.status === 'fulfilled') expect(l.reserved.toString()).toBe('1');
      else {
        expect((conf as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockException);
        expect(l.reserved.toString()).toBe('0');
      }
    }
  });

  it('§10.5(3)/§8.6 parallel deliveries of 12 orders: INV numbers unique and gap-free', async () => {
    const N = 12;
    const orders = await Promise.all(
      Array.from({ length: N }, async (_, i) =>
        confirmed(await newCustomer(), [{ p: i % 2 ? p1 : p2, qty: 1 }]),
      ),
    );
    const results = await Promise.allSettled(
      orders.map((o, i) =>
        run(() =>
          i % 3 === 0
            ? sales.deliver(o.id, user, { lines: [{ lineId: o.lines[0]!.id, deliveredQty: '1' }] })
            : sales.deliver(o.id, user),
        ),
      ),
    );
    onlyDomainErrors(results);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(N);

    const invs = await run((tx) =>
      tx.invoice.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { number: true } }),
    );
    const nums = invs.map((i) => Number(i.number.split('-')[2])).sort((x, y) => x - y);
    expect(new Set(invs.map((i) => i.number)).size).toBe(N);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1]! + 1);
    const counter = await run((tx) =>
      tx.documentCounter.findFirstOrThrow({ where: { companyId, docType: 'INV' } }),
    );
    expect(counter.lastNumber).toBe(nums[nums.length - 1]); // no number burned by a rolled-back attempt
  });

  it('§10.5(4) partial deliver vs customers.remove x4: no deadlock, exactly one wins, consistent', async () => {
    for (let round = 0; round < 4; round++) {
      const customerId = await newCustomer();
      const o = await confirmed(customerId, [{ p: p1, qty: 4 }]);
      const body = { lines: [{ lineId: o.lines[0]!.id, deliveredQty: '2' }] };
      const [d, r] = await Promise.allSettled([
        run(() => sales.deliver(o.id, user, body)),
        run(() => customers.remove(customerId, user)),
      ]);
      onlyDomainErrors([d, r]);
      const invoices = await run((tx) => tx.invoice.count({ where: { orderId: o.id } }));
      const cust = await run((tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } }));
      // ADR-061c: the open order always blocks delete, so deliver always wins.
      expect(d.status).toBe('fulfilled');
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason instanceof CustomerHasOutstandingBalanceException || reason instanceof CustomerHasOpenObligationsException).toBe(true);
      expect(invoices).toBe(1);
      expect(cust.deletedAt).toBeNull();
    }
  });

  it('§10.5(5) partial deliver [P1,P2] vs cancel/confirm of orders with opposite line order: no deadlock', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await confirmed(await newCustomer(), [
        { p: p1, qty: 3 },
        { p: p2, qty: 3 },
      ]);
      const b = await confirmed(await newCustomer(), [
        { p: p2, qty: 2 },
        { p: p1, qty: 2 },
      ]);
      const c = await submitted(await newCustomer(), [
        { p: p2, qty: 2 },
        { p: p1, qty: 2 },
      ]);
      const d = await submitted(await newCustomer(), [
        { p: p1, qty: 1 },
        { p: p2, qty: 1 },
      ]);
      const body = {
        lines: a.lines.map((l, i) => ({ lineId: l.id, deliveredQty: i === 0 ? '1' : '2' })),
      };
      const results = await Promise.allSettled([
        run(() => sales.deliver(a.id, user, body)),
        run(() => sales.cancel(b.id, { reason: 'race' }, user)),
        run(() => sales.confirm(c.id, user)),
        run(() => sales.confirm(d.id, user)),
        run(() => sales.deliver(d.id, user)),
      ]);
      onlyDomainErrors(results);
      expect(results[0]!.status).toBe('fulfilled');
      expect(results[1]!.status).toBe('fulfilled');
      expect(results[2]!.status).toBe('fulfilled');

      for (const p of [p1, p2]) {
        const l = await level(p.productId);
        expect(l.onHand.greaterThanOrEqualTo(0)).toBe(true);
        expect(l.reserved.greaterThanOrEqualTo(0)).toBe(true);
        expect(l.reserved.lessThanOrEqualTo(l.onHand)).toBe(true);
      }
    }
  });
});
