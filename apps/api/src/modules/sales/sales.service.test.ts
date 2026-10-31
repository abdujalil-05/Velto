import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma, prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AppException } from '../../common/errors/app-exception';
import { localDateString } from '../analytics/report-utils';
import { CustomerHasOpenObligationsException, CustomerHasOutstandingBalanceException, CustomerNotFoundException } from '../customers/customers-exceptions';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InsufficientStockException } from '../stock/stock-exceptions';
import { StockService } from '../stock/stock.service';
import {
  CourierNotFoundException,
  CustomerBlockedException,
  DeliveryLinesMismatchException,
  EmptyDeliveryException,
  InvalidDeliveredQtyException,
  InvalidOrderTransitionException,
  OrderNotAssignedToCourierException,
  OverDeliveryException,
  PartialDeliveryNotAllowedException,
  PriceChangedException,
  SalesOrderNotFoundException,
} from './sales-exceptions';
import { isDeliveredQtyCheckViolation } from './delivered-qty-check';
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

  it('clientId dedup is owner-scoped: same agent replays OK, another agent gets CLIENT_ID_CONFLICT without a leak, office role unaffected (TZ 11.2)', async () => {
  const mkAgent = async (n: string): Promise<AuthenticatedUser> => {
    const u = await systemPrisma.user.create({
      data: { companyId, firstName: n, lastName: 'Idor', phone: `+99893${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
    });
    return { id: u.id, companyId, firstName: n, lastName: 'Idor', roles: ['SALES_AGENT'], permissions: [] };
  };
  const customerId = await createCustomer();
  const a = await mkAgent('A');
  const b = await mkAgent('B');
  const clientId = randomUUID();
  const first = await tenantPrisma.run(companyId, () => sales.create({ customerId, clientId, lines: [{ productId, packagingId, qty: 1 }] }, a));
  const replay = await tenantPrisma.run(companyId, () => sales.create({ customerId, clientId, lines: [{ productId, packagingId, qty: 1 }] }, a));
  expect(replay.id).toBe(first.id);
  const err = await tenantPrisma
    .run(companyId, () => sales.create({ customerId, clientId, lines: [{ productId, packagingId, qty: 1 }] }, b))
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppException);
  expect(JSON.stringify((err as AppException).getResponse())).toContain('CLIENT_ID_CONFLICT');
  expect((err as AppException).getStatus()).toBe(409);
  expect(JSON.stringify((err as AppException).getResponse())).not.toContain(first.id);
  const office = await tenantPrisma.run(companyId, () => sales.create({ customerId, clientId, lines: [{ productId, packagingId, qty: 1 }] }, user));
  expect(office.id).toBe(first.id);
  });

  describe('F4 expectedUnitPrice (offline price confirmation)', () => {
    const soCounter = () =>
      tenantPrisma.run(companyId, (tx) =>
        tx.documentCounter.findFirst({ where: { docType: 'SO', year: new Date().getFullYear() }, select: { lastNumber: true } }),
      );

    it('creates the order when expectedUnitPrice equals the server price (compared as Decimal, "10000.00" == 10000)', async () => {
      const customerId = await createCustomer();
      const { order, created } = await tenantPrisma.run(companyId, () =>
        sales.createWithOutcome({ customerId, lines: [{ productId, packagingId, qty: 1, expectedUnitPrice: '10000.00' }] }, user),
      );
      expect(created).toBe(true);
      expect(order.lines[0]?.unitPrice.toString()).toBe('10000');
    });

    it('throws PRICE_CHANGED with per-line and total details, writing nothing and consuming no SO number — never reprices', async () => {
      const customerId = await createCustomer();
      const clientId = randomUUID();
      const before = await soCounter();
      const err = await tenantPrisma
        .run(companyId, () =>
          sales.create(
            {
              customerId,
              clientId,
              lines: [
                { productId, packagingId, qty: 2, expectedUnitPrice: '9000' },
                { productId, packagingId, qty: 1, expectedUnitPrice: '10000' },
              ],
            },
            user,
          ),
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PriceChangedException);
      const body = (err as PriceChangedException).getResponse() as { code: string; details: unknown };
      expect(body.code).toBe('PRICE_CHANGED');
      // expected: 2*9000*1.12 + 1*10000*1.12 = 31360; server: 3*10000*1.12 = 33600
      expect(body.details).toEqual({
        lines: [{ lineIndex: 0, productId, packagingId, expectedUnitPrice: '9000.00', serverUnitPrice: '10000.00' }],
        expectedTotal: '31360.00',
        serverTotal: '33600.00',
      });
      const persisted = await tenantPrisma.run(companyId, (tx) => tx.salesOrder.findUnique({ where: { companyId_clientId: { companyId, clientId } } }));
      expect(persisted).toBeNull();
      expect((await soCounter())?.lastNumber).toBe(before?.lastNumber);
    });

    it('a resubmitted, already-created clientId returns the original order even if the price changed since (DUPLICATE wins over PRICE_CHANGED)', async () => {
      const customerId = await createCustomer();
      const clientId = randomUUID();
      const first = await tenantPrisma.run(companyId, () =>
        sales.createWithOutcome({ customerId, clientId, lines: [{ productId, packagingId, qty: 1, expectedUnitPrice: '10000' }] }, user),
      );
      const again = await tenantPrisma.run(companyId, () =>
        sales.createWithOutcome({ customerId, clientId, lines: [{ productId, packagingId, qty: 1, expectedUnitPrice: '1' }] }, user),
      );
      expect(again.created).toBe(false);
      expect(again.order.id).toBe(first.order.id);
    });
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

    await expect(tenantPrisma.run(companyId, () => sales.cancel(order.id, { reason: 'late cancel' }, user))).rejects.toBeInstanceOf(
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
    const row = await tenantPrisma.run(companyId, (tx) => tx.salesOrder.findUniqueOrThrow({ where: { id: order.id } }));
    expect(row.cancelReason).toBe('customer changed mind');
    expect(row.cancelledBy).toBe(user.id);
    expect(row.cancelledAt).toBeInstanceOf(Date);
    const audit = await systemPrisma.auditLog.findFirst({ where: { companyId, action: 'order.cancel', entityId: order.id } });
    expect(audit?.newValue).toMatchObject({ reason: 'customer changed mind' });
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

    // Company-timezone calendar days (same helper the service uses), not UTC.
    const today = localDateString(new Date());
    const tomorrow = localDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));

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
      // ADR-061c: remove() now refuses a customer with a CONFIRMED order — simulate a legacy (pre-061) soft delete.
      await tenantPrisma.run(companyId, (tx) => tx.customer.update({ where: { id: customerId }, data: { deletedAt: new Date(), isActive: false } }));

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

    it('deliver vs customers.remove ×4 rounds: deliver always wins (ADR-061c: an open order blocks delete), never an invoice for a deleted customer', async () => {
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
        expect(deliverRes.status).toBe('fulfilled');
        expect(removeRes.status).toBe('rejected');
        // remove first → CONFIRMED order blocks; deliver first → the new invoice's debt blocks.
        const reason = (removeRes as PromiseRejectedResult).reason;
        expect(reason instanceof CustomerHasOutstandingBalanceException || reason instanceof CustomerHasOpenObligationsException).toBe(true);
        expect(invoices).toBe(1);
        expect(b.deletedAt).toBeNull();
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

  describe('F2.4 partial goods issue: deliver(lines[{lineId, deliveredQty}])', () => {
    let product2Id: string;
    let packaging2Id: string;

    beforeAll(async () => {
      await tenantPrisma.run(companyId, async (tx) => {
        const product = await tx.product.create({
          data: {
            companyId,
            sku: 'SALES-TEST-2',
            name: 'Sales Test Product 2',
            baseUnit: 'dona',
            vatRate: 12,
          },
        });
        product2Id = product.id;
        const packaging = await tx.productPackaging.create({
          data: { productId: product.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true },
        });
        packaging2Id = packaging.id;
        const priceList = await tx.priceList.findFirstOrThrow({ where: { isDefault: true } });
        await tx.priceListItem.create({
          data: { priceListId: priceList.id, productId: product.id, price: '999.99' },
        });
      });
      await tenantPrisma.run(companyId, () =>
        stock.receive({ productId: product2Id, warehouseId, qty: 1000 }, user),
      );
    });

    async function level(pid: string) {
      const l = await tenantPrisma.run(companyId, (tx) =>
        tx.stockLevel.findUniqueOrThrow({
          where: { productId_warehouseId: { productId: pid, warehouseId } },
        }),
      );
      return { onHand: l.onHand, reserved: l.reserved };
    }

    /** CONFIRMED order: line[0] = product1 × q1 (10000), line[1] = product2 × q2 (999.99), in the given order. */
    async function confirmedTwoLine(q1: number, q2: number, reverse = false) {
      const customerId = await createCustomer();
      const lines = [
        { productId, packagingId, qty: q1 },
        { productId: product2Id, packagingId: packaging2Id, qty: q2 },
      ];
      const order = await tenantPrisma.run(companyId, () =>
        sales.create({ customerId, lines: reverse ? lines.reverse() : lines }, user),
      );
      await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
      const byProduct = (pid: string) => order.lines.find((l) => l.productId === pid)!.id;
      return { order, customerId, line1: byProduct(productId), line2: byProduct(product2Id) };
    }

    async function writesFor(orderId: string) {
      return tenantPrisma.run(companyId, async (tx) => ({
        movements: await tx.stockMovement.count({
          where: { refId: orderId, type: { in: ['ISSUE', 'RELEASE'] } },
        }),
        invoices: await tx.invoice.count({ where: { orderId } }),
        order: await tx.salesOrder.findUniqueOrThrow({
          where: { id: orderId },
          include: { lines: true },
        }),
      }));
    }

    it('no body: full delivery writes deliveredQty = qty on every line, invoice = order snapshot total', async () => {
      const { order } = await confirmedTwoLine(2, 3);
      const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
      expect(delivered.status).toBe('DELIVERED');
      expect(delivered.lines.every((l) => l.deliveredQty.equals(l.qty))).toBe(true);
      const invoice = await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.findFirstOrThrow({ where: { orderId: order.id }, include: { lines: true } }),
      );
      expect(invoice.total.toString()).toBe(delivered.total.toString());
      expect(invoice.lines).toHaveLength(2);
      const releases = await tenantPrisma.run(companyId, (tx) =>
        tx.stockMovement.count({ where: { refId: order.id, type: 'RELEASE' } }),
      );
      expect(releases).toBe(0);
    });

    it('partial: issues delivered qty, releases the remainder, invoices only delivered qty (rounded half-up)', async () => {
      const p1Before = await level(productId);
      const p2Before = await level(product2Id);
      const { order, line1, line2 } = await confirmedTwoLine(10, 3);
      // CONFIRMED: total is the ordered amount (10 × 11200 + 3 × 1119.99 = 115359.97).
      const ordered = await tenantPrisma.run(companyId, () => sales.getById(order.id, user));
      expect(ordered.total.toString()).toBe('115359.97');

      const delivered = await tenantPrisma.run(companyId, () =>
        sales.deliver(order.id, user, {
          lines: [
            { lineId: line2, deliveredQty: '1' },
            { lineId: line1, deliveredQty: '4' },
          ],
        }),
      );
      expect(delivered.status).toBe('DELIVERED');
      expect(delivered.lines.find((l) => l.id === line1)!.deliveredQty.toString()).toBe('4');
      expect(delivered.lines.find((l) => l.id === line2)!.deliveredQty.toString()).toBe('1');

      const p1 = await level(productId);
      const p2 = await level(product2Id);
      expect(p1Before.onHand.minus(p1.onHand).toString()).toBe('4');
      expect(p2Before.onHand.minus(p2.onHand).toString()).toBe('1');
      expect(p1.reserved.toString()).toBe(p1Before.reserved.toString());
      expect(p2.reserved.toString()).toBe(p2Before.reserved.toString());

      const moves = await tenantPrisma.run(companyId, (tx) =>
        tx.stockMovement.findMany({
          where: { refId: order.id, type: { in: ['ISSUE', 'RELEASE'] } },
        }),
      );
      const qtyOf = (pid: string, type: string) =>
        moves.find((m) => m.productId === pid && m.type === type)?.qty.toString();
      expect(qtyOf(productId, 'ISSUE')).toBe('4');
      expect(qtyOf(productId, 'RELEASE')).toBe('6');
      expect(qtyOf(product2Id, 'ISSUE')).toBe('1');
      expect(qtyOf(product2Id, 'RELEASE')).toBe('2');

      const invoice = await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.findFirstOrThrow({ where: { orderId: order.id }, include: { lines: true } }),
      );
      // 4 × 10000 × 1.12 = 44800; 1 × 999.99 × 1.12 = 1119.9888 → 1119.99
      expect(invoice.lines.find((l) => l.productId === productId)!.lineTotal.toString()).toBe(
        '44800',
      );
      expect(invoice.lines.find((l) => l.productId === product2Id)!.lineTotal.toString()).toBe(
        '1119.99',
      );
      expect(invoice.total.toString()).toBe('45919.99');
      // DELIVERED: order.total is the delivered amount and equals invoice.total,
      // both in deliver()'s return value and on a later read.
      expect(delivered.total.toString()).toBe('45919.99');
      const reread = await tenantPrisma.run(companyId, () => sales.getById(order.id, user));
      expect(reread.total.toString()).toBe(invoice.total.toString());

      const audit = await tenantPrisma.run(companyId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: 'order.deliver' } }),
      );
      const auditLines = (
        audit.newValue as { lines: { lineId: string; deliveredQty: string; releasedQty: string }[] }
      ).lines;
      expect(auditLines.find((l) => l.lineId === line1)).toMatchObject({
        deliveredQty: '4',
        releasedQty: '6',
      });
    });

    it('isDeliveredQtyCheckViolation matches the real Postgres/Prisma error for the range CHECK only', async () => {
      const { line1 } = await confirmedTwoLine(2, 1);
      const checkErr = await tenantPrisma
        .run(companyId, (tx) =>
          tx.salesOrderLine.update({ where: { id: line1 }, data: { deliveredQty: '3' } }),
        )
        .catch((e: unknown) => e);
      expect(checkErr).toBeInstanceOf(Error);
      expect(isDeliveredQtyCheckViolation(checkErr)).toBe(true);

      // A different DB error (unique violation on Product.sku) must not match.
      const uniqueErr = await tenantPrisma
        .run(companyId, (tx) =>
          tx.product.create({ data: { companyId, sku: 'SALES-TEST-2', name: 'dup', baseUnit: 'dona' } }),
        )
        .catch((e: unknown) => e);
      expect(uniqueErr).toBeInstanceOf(Error);
      expect(isDeliveredQtyCheckViolation(uniqueErr)).toBe(false);

      const untouched = await tenantPrisma.run(companyId, (tx) =>
        tx.salesOrderLine.findUniqueOrThrow({ where: { id: line1 } }),
      );
      expect(untouched.deliveredQty.toString()).toBe('0');
    });

    it('a 0-qty line is fully released and omitted from the invoice', async () => {
      const p2Before = await level(product2Id);
      const { order, line1, line2 } = await confirmedTwoLine(2, 5);
      await tenantPrisma.run(companyId, () =>
        sales.deliver(order.id, user, {
          lines: [
            { lineId: line1, deliveredQty: '2' },
            { lineId: line2, deliveredQty: '0' },
          ],
        }),
      );
      const p2 = await level(product2Id);
      expect(p2.onHand.toString()).toBe(p2Before.onHand.toString());
      expect(p2.reserved.toString()).toBe(p2Before.reserved.toString());
      const invoice = await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.findFirstOrThrow({ where: { orderId: order.id }, include: { lines: true } }),
      );
      expect(invoice.lines.map((l) => l.productId)).toEqual([productId]);
      expect(invoice.total.toString()).toBe('22400');
    });

    it.each([
      [
        'over-delivery',
        (l1: string, l2: string) => [
          { lineId: l1, deliveredQty: '2.001' },
          { lineId: l2, deliveredQty: '1' },
        ],
        OverDeliveryException,
      ],
      [
        'all zero',
        (l1: string, l2: string) => [
          { lineId: l1, deliveredQty: '0' },
          { lineId: l2, deliveredQty: '0' },
        ],
        EmptyDeliveryException,
      ],
      [
        'negative',
        (l1: string, l2: string) => [
          { lineId: l1, deliveredQty: '-1' },
          { lineId: l2, deliveredQty: '1' },
        ],
        InvalidDeliveredQtyException,
      ],
      [
        'missing line',
        (l1: string) => [{ lineId: l1, deliveredQty: '1' }],
        DeliveryLinesMismatchException,
      ],
      [
        'duplicate line',
        (l1: string, l2: string) => [
          { lineId: l1, deliveredQty: '1' },
          { lineId: l1, deliveredQty: '1' },
          { lineId: l2, deliveredQty: '1' },
        ],
        DeliveryLinesMismatchException,
      ],
      [
        'unknown line',
        (l1: string, l2: string) => [
          { lineId: l1, deliveredQty: '1' },
          { lineId: l2, deliveredQty: '1' },
          { lineId: randomUUID(), deliveredQty: '1' },
        ],
        DeliveryLinesMismatchException,
      ],
    ])(
      'rejects %s with nothing written (no movement, no invoice, still CONFIRMED)',
      async (_name, build, errorClass) => {
        const reservedBefore = await level(productId);
        const { order, line1, line2 } = await confirmedTwoLine(2, 3);
        await expect(
          tenantPrisma.run(companyId, () =>
            sales.deliver(order.id, user, { lines: build(line1, line2) }),
          ),
        ).rejects.toBeInstanceOf(errorClass);

        const w = await writesFor(order.id);
        expect(w.movements).toBe(0);
        expect(w.invoices).toBe(0);
        expect(w.order.status).toBe('CONFIRMED');
        expect(w.order.lines.every((l) => l.deliveredQty.isZero())).toBe(true);
        expect((await level(productId)).reserved.minus(reservedBefore.reserved).toString()).toBe(
          '2',
        );
      },
    );

    it('a courier-only session cannot send partial lines (Mini App path is full delivery only)', async () => {
      const customerId = await createCustomer();
      const order = await tenantPrisma.run(companyId, () =>
        sales.create({ customerId, courierId, lines: [{ productId, packagingId, qty: 2 }] }, user),
      );
      await expect(
        tenantPrisma.run(companyId, () =>
          sales.deliver(order.id, courierUser, {
            lines: [{ lineId: order.lines[0]!.id, deliveredQty: '1' }],
          }),
        ),
      ).rejects.toBeInstanceOf(PartialDeliveryNotAllowedException);
      expect((await writesFor(order.id)).movements).toBe(0);
    });

    it('race: parallel confirm + partial deliver of orders with opposite line order — no deadlock, stock consistent', async () => {
      const p1Before = await level(productId);
      const p2Before = await level(product2Id);
      const N = 4;
      const orders = await Promise.all(
        Array.from({ length: N }, (_, i) => confirmedTwoLine(3, 3, i % 2 === 1)),
      );
      // A second wave confirmed concurrently with the deliveries below.
      const customerId = await createCustomer();
      const pending = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          tenantPrisma.run(companyId, () =>
            sales.create(
              {
                customerId,
                lines:
                  i % 2
                    ? [
                        { productId: product2Id, packagingId: packaging2Id, qty: 1 },
                        { productId, packagingId, qty: 1 },
                      ]
                    : [
                        { productId, packagingId, qty: 1 },
                        { productId: product2Id, packagingId: packaging2Id, qty: 1 },
                      ],
              },
              user,
            ),
          ),
        ),
      );

      const results = await Promise.allSettled([
        ...orders.map(({ order, line1, line2 }) =>
          tenantPrisma.run(companyId, () =>
            sales.deliver(order.id, user, {
              lines: [
                { lineId: line1, deliveredQty: '1' },
                { lineId: line2, deliveredQty: '2' },
              ],
            }),
          ),
        ),
        ...pending.map((o) => tenantPrisma.run(companyId, () => sales.confirm(o.id, user))),
      ]);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(failures.map((f) => String(f.reason))).toEqual([]);

      const p1 = await level(productId);
      const p2 = await level(product2Id);
      expect(p1Before.onHand.minus(p1.onHand).toString()).toBe(String(N * 1));
      expect(p2Before.onHand.minus(p2.onHand).toString()).toBe(String(N * 2));
      // Only the second wave's reservations remain.
      expect(p1.reserved.minus(p1Before.reserved).toString()).toBe(String(N));
      expect(p2.reserved.minus(p2Before.reserved).toString()).toBe(String(N));
    });
  });
});
