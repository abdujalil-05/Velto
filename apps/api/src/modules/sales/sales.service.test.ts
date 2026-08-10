import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SuppliersService } from '../purchases/suppliers/suppliers.service';
import { InsufficientStockException } from '../stock/stock-exceptions';
import { StockService } from '../stock/stock.service';
import { CustomerBlockedException, InvalidOrderTransitionException, SalesOrderNotFoundException } from './sales-exceptions';
import { SalesService } from './sales.service';

describe('SalesService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let productId: string;
  let packagingId: string;
  let supplierId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog);
  const docNumbering = new DocumentNumberingService();
  const suppliers = new SuppliersService(tenantPrisma, auditLog);
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, suppliers, notifications);

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

      const supplier = await tx.supplier.create({ data: { companyId, name: 'Sales Test Supplier' } });
      supplierId = supplier.id;
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

  it('creating with a supplierId skips straight to SHIPPED, reserves stock, and deliver() works from there', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, supplierId, lines: [{ productId, packagingId, qty: 2 }] }, user),
    );
    expect(order.status).toBe('SHIPPED');
    expect(order.supplierId).toBe(supplierId);
    expect(order.deliverySupplier?.id).toBe(supplierId);
    expect((await getReserved()).minus(before).toString()).toBe('2');

    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    expect(delivered.status).toBe('DELIVERED');
    expect((await getReserved()).toString()).toBe(before.toString());
  });

  it('assignSupplier() on a SUBMITTED order reserves stock and moves it to SHIPPED', async () => {
    const before = await getReserved();
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    expect(order.status).toBe('SUBMITTED');

    const assigned = await tenantPrisma.run(companyId, () => sales.assignSupplier(order.id, { supplierId }, user));
    expect(assigned.status).toBe('SHIPPED');
    expect(assigned.supplierId).toBe(supplierId);
    expect((await getReserved()).minus(before).toString()).toBe('1');
  });

  it('assignSupplier() on a CONFIRMED order does not double-reserve, and is rejected once DELIVERED', async () => {
    const customerId = await createCustomer();
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    const before = await getReserved();

    const assigned = await tenantPrisma.run(companyId, () => sales.assignSupplier(order.id, { supplierId }, user));
    expect(assigned.status).toBe('SHIPPED');
    expect((await getReserved()).toString()).toBe(before.toString());

    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    expect(delivered.status).toBe('DELIVERED');

    await expect(
      tenantPrisma.run(companyId, () => sales.assignSupplier(order.id, { supplierId }, user)),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionException);
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
});
