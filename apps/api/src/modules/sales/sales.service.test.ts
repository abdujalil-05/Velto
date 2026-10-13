import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma, prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AppException } from '../../common/errors/app-exception';
import { CustomerHasOutstandingBalanceException, CustomerNotFoundException } from '../customers/customers-exceptions';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InsufficientStockException } from '../stock/stock-exceptions';
import { StockService } from '../stock/stock.service';
import {
  CourierNotFoundException,
  CustomerBlockedException,
  InvalidOrderTransitionException,
  OrderNotAssignedToCourierException,
  SalesOrderNotFoundException,
} from './sales-exceptions';
import { SalesService } from './sales.service';

describe('SalesService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let productId: string;
  let packagingId: string;
  let courierId: string;
  let courierUser: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog);
  const docNumbering = new DocumentNumberingService();
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, notifications);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-sales-${Date.now()}`, name: 'Sales Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Sales Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Op', lastName: 'User', phone: '+998900000003' },
    });
    user = { id: dbUser.id, companyId, firstName: 'Op', lastName: 'User', roles: ['WAREHOUSE'], permissions: ['orders.update'] };

    await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Sales Test Warehouse' } });
      warehouseId = warehouse.id;

      const product = await tx.product.create({
        data: { companyId, sku: 'SALES-TEST-1', name: 'Sales Test Product', baseUnit: 'dona', vatRate: 12 },
      });
      productId = product.id;

      const packaging = await tx.productPackaging.create({
        data: { productId: product.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true },
      });
      packagingId = packaging.id;

      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: product.id, price: '10000' } });

      // A courier is an ordinary User carrying the COURIER system role — the
      // role row has to exist here because this test builds its tenant by
      // hand rather than through seed.ts's RBAC catalog.
      const courierRole = await tx.role.create({
        data: { companyId, code: 'COURIER', name: 'Kuryer', isSystem: true },
      });
      const courier = await tx.user.create({
        data: {
          companyId,
          firstName: 'Kuryer',
          lastName: 'Test',
          phone: `+9989000${Math.floor(Math.random() * 90000) + 10000}`,
          roles: { create: { roleId: courierRole.id } },
        },
      });
      courierId = courier.id;
      courierUser = {
        id: courier.id,
        companyId,
        firstName: 'Kuryer',
        lastName: 'Test',
        roles: ['COURIER'],
        permissions: ['orders.read', 'orders.deliver'],
      };
    });

    await tenantPrisma.run(companyId, () => stock.receive({ productId, warehouseId, qty: 1000 }, user));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function createCustomer() {
    const { customer } = await tenantPrisma.run(companyId, () =>
      customers.create({ code: `SALES-CUST-${Date.now()}-${Math.random()}`, name: 'Sales Test Customer' }, user),
    );
    return (customer as { id: string }).id;
  }

  it('creates an order with a server-computed line total (qty in packaging units, converted to base + VAT)', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 5 }] }, user),
    );
    // 5 * 10000 * (1 - 0/100) * (1 + 12/100) = 56000
    expect(order.total.toString()).toBe('56000');
    expect(order.status).toBe('SUBMITTED');
    expect(order.lines[0]?.qty.toString()).toBe('5'); // packaging qtyInBaseUnit=1, so base qty === packaging qty here
  });

  it('resubmitting the same clientId returns the original order instead of erroring (10.4 offline idempotency)', async () => {
    const customerId = await createCustomer();
    // clientId is globally unique (not scoped per tenant — see 6.6, it's a
    // client-device-generated offline idempotency key), so it must be fresh
    // per test run rather than a fixed literal.
    const clientId = randomUUID();
    const first = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, clientId, lines: [{ productId, packagingId, qty: 2 }] }, user),
    );
    const second = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, clientId, lines: [{ productId, packagingId, qty: 999 }] }, user),
    );
    expect(second.id).toBe(first.id);
    expect(second.total.toString()).toBe(first.total.toString());
  });

  it('rejects order creation outright for a blocked customer', async () => {
    const customerId = await createCustomer();
    await tenantPrisma.run(companyId, (tx) => tx.customer.update({ where: { id: customerId }, data: { isBlocked: true } }));

    await expect(
      tenantPrisma.run(companyId, () => sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user)),
    ).rejects.toBeInstanceOf(CustomerBlockedException);
  });

  it('confirm is a single plain SUBMITTED -> CONFIRMED step, gated only by orders.update', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 5 }] }, user),
    );
    expect(order.status).toBe('SUBMITTED');

    const confirmed = await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('SEC-023 (15.3): a SALES_AGENT only sees their own orders via list()/getById()', async () => {
    const [agent1, agent2] = await Promise.all(
      ['+998900000094', '+998900000095'].map(async (phone, i) => {
        const dbUser = await systemPrisma.user.create({
          data: { companyId, firstName: 'Scoped', lastName: `Agent${i + 1}`, phone },
        });
        return {
          id: dbUser.id,
          companyId,
          firstName: 'Scoped',
          lastName: `Agent${i + 1}`,
          roles: ['SALES_AGENT'],
          permissions: ['orders.create', 'orders.read'],
        } satisfies AuthenticatedUser;
      }),
    );

    const customerId = await createCustomer();
    const order1 = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, agent1),
    );
    const order2 = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, agent2),
    );

    const agent1List = await tenantPrisma.run(companyId, () => sales.list({ page: 1, pageSize: 100 }, agent1));
    const ids = agent1List.data.map((o) => o.id);
    expect(ids).toContain(order1.id);
    expect(ids).not.toContain(order2.id);

    // Passing another agent's id in the query must not override the
    // server-enforced scope for a SALES_AGENT caller.
    const spoofedList = await tenantPrisma.run(companyId, () =>
      sales.list({ page: 1, pageSize: 100, agentId: agent2.id }, agent1),
    );
    expect(spoofedList.data.map((o) => o.id)).not.toContain(order2.id);

    await expect(tenantPrisma.run(companyId, () => sales.getById(order2.id, agent1))).rejects.toBeInstanceOf(
      SalesOrderNotFoundException,
    );
    const ownOrder = await tenantPrisma.run(companyId, () => sales.getById(order1.id, agent1));
    expect(ownOrder.id).toBe(order1.id);

    // Non-agent roles (e.g. WAREHOUSE) remain unrestricted.
    const opList = await tenantPrisma.run(companyId, () => sales.list({ page: 1, pageSize: 100 }, user));
    expect(opList.data.map((o) => o.id)).toEqual(expect.arrayContaining([order1.id, order2.id]));
  });

  async function getReserved() {
    const level = await tenantPrisma.run(companyId, (tx) =>
      tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } }),
    );
    return level!.reserved;
  }

  // These tests share one product/warehouse with the rest of the suite (a
  // prior test's CONFIRMED-but-never-delivered order leaves a real, correct
  // reservation behind) — so they assert the *change* in reserved qty, not
  // an absolute value.
  it('confirm reserves stock; deliver issues it and creates a 1:1 invoice; cancel is then rejected', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 3 }] }, user),
    );

    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    expect((await getReserved()).minus(before).toString()).toBe('3');

    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    expect(delivered.status).toBe('DELIVERED');

    const invoice = await tenantPrisma.run(companyId, (tx) => tx.invoice.findFirst({ where: { orderId: order.id } }));
    expect(invoice?.total.toString()).toBe(delivered.total.toString());

    // Delivery issues the reservation away entirely — back to the baseline.
    expect((await getReserved()).toString()).toBe(before.toString());

    await expect(tenantPrisma.run(companyId, () => sales.cancel(order.id, {}, user))).rejects.toBeInstanceOf(
      InvalidOrderTransitionException,
    );
  });

  it('cancelling a CONFIRMED order releases its stock reservation', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 4 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    expect((await getReserved()).minus(before).toString()).toBe('4');

    const cancelled = await tenantPrisma.run(companyId, () =>
      sales.cancel(order.id, { reason: 'customer changed mind' }, user),
    );
    expect(cancelled.status).toBe('CANCELLED');
    expect((await getReserved()).toString()).toBe(before.toString());
  });

  it('two parallel confirms of one order reserve exactly once (order row lock)', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 6 }] }, user),
    );

    const results = await Promise.allSettled(
      [0, 1].map(() => tenantPrisma.run(companyId, () => sales.confirm(order.id, user))),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvalidOrderTransitionException);

    expect((await getReserved()).minus(before).toString()).toBe('6');
    const reserves = await tenantPrisma.run(companyId, (tx) =>
      tx.stockMovement.count({ where: { refId: order.id, type: 'RESERVE' } }),
    );
    expect(reserves).toBe(1);
  });

  it('two parallel delivers of one order issue stock once and create exactly one invoice', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 2 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    const onHandBefore = (
      await tenantPrisma.run(companyId, (tx) =>
        tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } }),
      )
    )!.onHand;

    const results = await Promise.allSettled(
      [0, 1].map(() => tenantPrisma.run(companyId, () => sales.deliver(order.id, user))),
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvalidOrderTransitionException);

    const [invoices, issues, level] = await tenantPrisma.run(companyId, (tx) =>
      Promise.all([
        tx.invoice.count({ where: { orderId: order.id } }),
        tx.stockMovement.count({ where: { refId: order.id, type: 'ISSUE' } }),
        tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } }),
      ]),
    );
    expect(invoices).toBe(1);
    expect(issues).toBe(1);
    expect(onHandBefore.minus(level!.onHand).toString()).toBe('2');
    expect(level!.reserved.toString()).toBe(before.toString());
  });

  it('list() filters by from/to (createdAt), leaving unbounded callers unaffected', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const todayList = await tenantPrisma.run(companyId, () =>
      sales.list({ page: 1, pageSize: 100, customerId, from: today, to: today }, user),
    );
    expect(todayList.data.map((o) => o.id)).toContain(order.id);

    const futureList = await tenantPrisma.run(companyId, () =>
      sales.list({ page: 1, pageSize: 100, customerId, from: tomorrow, to: tomorrow }, user),
    );
    expect(futureList.data.map((o) => o.id)).not.toContain(order.id);

    const unbounded = await tenantPrisma.run(companyId, () => sales.list({ page: 1, pageSize: 100, customerId }, user));
    expect(unbounded.data.map((o) => o.id)).toContain(order.id);
  });

  it('confirm fails with InsufficientStockException when requesting more than available', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1_000_000_000 }] }, user),
    );
    await expect(tenantPrisma.run(companyId, () => sales.confirm(order.id, user))).rejects.toBeInstanceOf(
      InsufficientStockException,
    );
  });

  it('creating with a courierId skips straight to SHIPPED, reserves stock, and deliver() works from there', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, courierId, lines: [{ productId, packagingId, qty: 2 }] }, user),
    );
    expect(order.status).toBe('SHIPPED');
    expect(order.courierId).toBe(courierId);
    expect(order.courier?.id).toBe(courierId);
    expect((await getReserved()).minus(before).toString()).toBe('2');

    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    expect(delivered.status).toBe('DELIVERED');
    expect((await getReserved()).toString()).toBe(before.toString());
  });

  it('assignCourier() on a SUBMITTED order reserves stock and moves it to SHIPPED', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    expect(order.status).toBe('SUBMITTED');

    const assigned = await tenantPrisma.run(companyId, () => sales.assignCourier(order.id, { courierId }, user));
    expect(assigned.status).toBe('SHIPPED');
    expect(assigned.courierId).toBe(courierId);
    expect((await getReserved()).minus(before).toString()).toBe('1');
  });

  it('assignCourier() on a CONFIRMED order does not double-reserve, and is rejected once DELIVERED', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    const before = await getReserved();

    const assigned = await tenantPrisma.run(companyId, () => sales.assignCourier(order.id, { courierId }, user));
    expect(assigned.status).toBe('SHIPPED');
    expect((await getReserved()).toString()).toBe(before.toString());

    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    expect(delivered.status).toBe('DELIVERED');

    await expect(
      tenantPrisma.run(companyId, () => sales.assignCourier(order.id, { courierId }, user)),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionException);
  });

  it('assignCourier() rejects a user who does not hold the COURIER role', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );

    // `user` is a real, active User in this tenant — but a WAREHOUSE one, so
    // only the role check (not the FK) can reject it.
    await expect(
      tenantPrisma.run(companyId, () => sales.assignCourier(order.id, { courierId: user.id }, user)),
    ).rejects.toBeInstanceOf(CourierNotFoundException);
  });

  it('a courier cannot deliver an order that is not assigned to them', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));

    // CONFIRMED and deliverable — the only thing stopping this courier is
    // that `courierId` is still null.
    await expect(
      tenantPrisma.run(companyId, () => sales.deliver(order.id, courierUser)),
    ).rejects.toBeInstanceOf(OrderNotAssignedToCourierException);

    // ...and warehouse is unaffected by the courier guard.
    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    expect(delivered.status).toBe('DELIVERED');
  });

  it('a courier delivers their own assigned order, and list()/getById() are scoped to it', async () => {
    const customerId = await createCustomer();
    const mine = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, courierId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    const someoneElses = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );

    const listed = await tenantPrisma.run(companyId, () => sales.list({ page: 1, pageSize: 100 }, courierUser));
    const ids = listed.data.map((o) => o.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(someoneElses.id);
    // A courierId in the query can't widen that scope back out, nor narrow it
    // to nothing — it is ignored outright for a courier session.
    const spoofed = await tenantPrisma.run(companyId, () =>
      sales.list({ page: 1, pageSize: 100, courierId: randomUUID() }, courierUser),
    );
    expect(spoofed.data.map((o) => o.id)).toContain(mine.id);
    expect(spoofed.data.map((o) => o.id)).not.toContain(someoneElses.id);

    await expect(
      tenantPrisma.run(companyId, () => sales.getById(someoneElses.id, courierUser)),
    ).rejects.toBeInstanceOf(SalesOrderNotFoundException);

    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(mine.id, courierUser));
    expect(delivered.status).toBe('DELIVERED');

    // Warehouse still sees both orders — self-scoping is courier-only.
    const asWarehouse = await tenantPrisma.run(companyId, () => sales.list({ page: 1, pageSize: 100 }, user));
    expect(asWarehouse.data.map((o) => o.id)).toEqual(expect.arrayContaining([mine.id, someoneElses.id]));
  });

  it('remove() rejects deleting anything past SUBMITTED', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));

    await expect(tenantPrisma.run(companyId, () => sales.remove(order.id, user))).rejects.toBeInstanceOf(
      InvalidOrderTransitionException,
    );
  });

  it('remove() deletes a SUBMITTED order outright', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.remove(order.id, user));

    await expect(tenantPrisma.run(companyId, () => sales.getById(order.id, user))).rejects.toBeInstanceOf(
      SalesOrderNotFoundException,
    );
  });
  it('SEC-023: courier self-scoping depends on the role code — COURIER+WAREHOUSE and non-courier keep the wide view', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));

    // Same identity, only the role codes differ.
    const courierOnly = { ...courierUser, roles: ['COURIER'] };
    const courierWarehouse = { ...courierUser, roles: ['COURIER', 'WAREHOUSE'] };
    const noCourierRole = { ...courierUser, roles: ['ACCOUNTANT'] };

    await expect(
      tenantPrisma.run(companyId, () => sales.getById(order.id, courierOnly)),
    ).rejects.toBeInstanceOf(SalesOrderNotFoundException);
    const wide = await tenantPrisma.run(companyId, () => sales.getById(order.id, courierWarehouse));
    expect(wide.id).toBe(order.id);
    const plain = await tenantPrisma.run(companyId, () => sales.getById(order.id, noCourierRole));
    expect(plain.id).toBe(order.id);

    await expect(
      tenantPrisma.run(companyId, () => sales.deliver(order.id, courierOnly)),
    ).rejects.toBeInstanceOf(OrderNotAssignedToCourierException);
  });

  // TZ 16.1 P0: "5 qatorli buyurtma ... server line total, VAT/discount va order total'ni qayta hisoblaydi".
  // Formula (sales.service create()): baseQty * price * (1 - disc/100) * (1 + vat/100), stored Decimal(18,2).
  it('16.1 P0: 5-line order — server recomputes every line total (VAT + discount + packaging) and order total exactly', async () => {
    const customerId = await createCustomer();
    const tag = Date.now();
    const spec = [
      // price, qty, packQty, disc, vat -> expected lineTotal
      { price: '10000', qty: 3, pack: 1, disc: 0, vat: 12, total: '33600' },
      { price: '25000', qty: 2, pack: 1, disc: 10, vat: 12, total: '50400' },
      { price: '3333.33', qty: 3, pack: 1, disc: 5, vat: 15, total: '10924.99' }, // 10924.988075 -> 2dp
      { price: '1500', qty: 2, pack: 6, disc: 12.5, vat: 0, total: '15750' }, // 2 boxes x 6 = 12 base
      { price: '799.90', qty: 7, pack: 1, disc: 33.33, vat: 12, total: '4181.02' }, // 4181.0197072 -> 2dp
    ];
    const lines = await tenantPrisma.run(companyId, async (tx) => {
      const priceList = await tx.priceList.findFirstOrThrow({ where: { isDefault: true } });
      const out: { productId: string; packagingId: string; qty: number; discountPct: number }[] = [];
      for (const [i, sp] of spec.entries()) {
        const product = await tx.product.create({
          data: { companyId, sku: `VAT5-${tag}-${i}`, name: `VAT5 ${i}`, baseUnit: 'dona', vatRate: sp.vat },
        });
        const pk = await tx.productPackaging.create({
          data: { productId: product.id, name: 'pk', qtyInBaseUnit: sp.pack, isDefault: true },
        });
        await tx.priceListItem.create({ data: { priceListId: priceList.id, productId: product.id, price: sp.price } });
        out.push({ productId: product.id, packagingId: pk.id, qty: sp.qty, discountPct: sp.disc });
      }
      return out;
    });

    const order = await tenantPrisma.run(companyId, () => sales.create({ customerId, lines }, user));
    expect(order.lines).toHaveLength(5);
    const byProduct = new Map(order.lines.map((l) => [l.productId, l]));
    spec.forEach((sp, i) => {
      const l = byProduct.get(lines[i]!.productId)!;
      expect(l.lineTotal.toString(), `line ${i + 1}`).toBe(sp.total);
      expect(l.qty.toString(), `qty ${i + 1}`).toBe(String(sp.qty * sp.pack));
      expect(l.unitPrice.toString()).toBe(new (l.unitPrice.constructor as new (v: string) => typeof l.unitPrice)(sp.price).toString());
      expect(l.vatRate.toString()).toBe(String(sp.vat));
      expect(l.discountPct.toString()).toBe(String(sp.disc));
    });
    // 33600 + 50400 + 10924.99 + 15750 + 4181.02
    expect(order.total.toString()).toBe('114856.01');
  });

  describe('customer lock order: SalesOrder → Customer → StockLevel → Invoice (deliver vs remove/payments)', () => {
    const ROUNDS = 4;

    async function confirmedOrder(customerId: string, qty = 1) {
      const order = await tenantPrisma.run(companyId, () =>
        sales.create({ customerId, lines: [{ productId, packagingId, qty }] }, user),
      );
      await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
      return order;
    }

    async function balances(customerId: string) {
      return tenantPrisma.run(companyId, async (tx) => {
        const row = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
        const ledger = await customers.getBalance(tx, customerId);
        return { cached: row.cachedBalance.toString(), ledger: ledger.toString(), deletedAt: row.deletedAt };
      });
    }

    /** A deadlock (40P01) or any non-domain error surfaces as a non-AppException rejection. */
    function expectOnlyDomainErrors(results: PromiseSettledResult<unknown>[]) {
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AppException);
      }
    }

    it('deliver refuses a soft-deleted customer: no ISSUE, no invoice, order stays CONFIRMED', async () => {
      const customerId = await createCustomer();
      const order = await confirmedOrder(customerId);
      await tenantPrisma.run(companyId, () => customers.remove(customerId, user));

      await expect(tenantPrisma.run(companyId, () => sales.deliver(order.id, user))).rejects.toBeInstanceOf(
        CustomerNotFoundException,
      );
      const [invoices, issues, status] = await tenantPrisma.run(companyId, async (tx) => [
        await tx.invoice.count({ where: { orderId: order.id } }),
        await tx.stockMovement.count({ where: { refId: order.id, type: 'ISSUE' } }),
        (await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
      ]);
      expect(invoices).toBe(0);
      expect(issues).toBe(0);
      expect(status).toBe('CONFIRMED');
    });

    it('parallel deliver ×4 of one customer\'s orders: all succeed, no deadlock, cachedBalance = ledger', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const customerId = await createCustomer();
        const orders = await Promise.all([0, 1, 2, 3].map(() => confirmedOrder(customerId)));
        const results = await Promise.allSettled(
          orders.map((o) => tenantPrisma.run(companyId, () => sales.deliver(o.id, user))),
        );
        expectOnlyDomainErrors(results);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
        const b = await balances(customerId);
        expect(b.cached).toBe(b.ledger);
        expect(b.ledger).toBe(orders.reduce((sum, o) => sum.plus(o.total), new Prisma.Decimal(0)).toString());
      }
    });

    it('deliver vs customers.remove ×4 rounds: exactly one wins, never an invoice for a deleted customer', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const customerId = await createCustomer();
        const order = await confirmedOrder(customerId);
        const [deliverRes, removeRes] = await Promise.allSettled([
          tenantPrisma.run(companyId, () => sales.deliver(order.id, user)),
          tenantPrisma.run(companyId, () => customers.remove(customerId, user)),
        ]);
        expectOnlyDomainErrors([deliverRes, removeRes]);
        const invoices = await tenantPrisma.run(companyId, (tx) => tx.invoice.count({ where: { orderId: order.id } }));
        const b = await balances(customerId);
        if (deliverRes.status === 'fulfilled') {
          expect(removeRes.status).toBe('rejected');
          expect((removeRes as PromiseRejectedResult).reason).toBeInstanceOf(CustomerHasOutstandingBalanceException);
          expect(invoices).toBe(1);
          expect(b.deletedAt).toBeNull();
        } else {
          expect(removeRes.status).toBe('fulfilled');
          expect(deliverRes.reason).toBeInstanceOf(CustomerNotFoundException);
          expect(invoices).toBe(0);
          expect(b.deletedAt).not.toBeNull();
        }
        expect(b.cached).toBe(b.ledger);
      }
    });

    it('deliver vs payments.create ×4 rounds: both succeed, no deadlock, Σallocations ≤ payment, cachedBalance = ledger', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const customerId = await createCustomer();
        const first = await confirmedOrder(customerId);
        await tenantPrisma.run(companyId, () => sales.deliver(first.id, user)); // an open invoice for FIFO to hit
        const second = await confirmedOrder(customerId);
        const amount = 30000;

        const results = await Promise.allSettled([
          tenantPrisma.run(companyId, () => sales.deliver(second.id, user)),
          tenantPrisma.run(companyId, () => payments.create({ customerId, amount, method: 'CASH' }, user)),
        ]);
        expectOnlyDomainErrors(results);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

        const allocated = await tenantPrisma.run(companyId, (tx) =>
          tx.paymentAllocation.aggregate({ where: { payment: { customerId } }, _sum: { amount: true } }),
        );
        expect(allocated._sum.amount!.lessThanOrEqualTo(amount)).toBe(true);
        const b = await balances(customerId);
        expect(b.cached).toBe(b.ledger);
        expect(b.ledger).toBe(first.total.plus(second.total).minus(amount).toString());
      }
    });
  });
});
