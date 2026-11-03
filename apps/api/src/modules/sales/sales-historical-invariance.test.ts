import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { grantRole } from '../../common/testing/grant-role';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';
import { StockService } from '../stock/stock.service';
import { SalesService } from './sales.service';

type AppErr = { getStatus(): number; getResponse(): { code: string; details?: Record<string, unknown> } };

/**
 * ADR-059b/059a: assignCourier minPrice re-check without side effects, historical documents are immutable
 * when minPrice / Company.defaultVatRate change later, and tenant B's settings never reach tenant A.
 */
describe('ADR-059: assignCourier minPrice, historical invariance, tenant isolation (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const docNumbering = new DocumentNumberingService();
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, new NotificationsService(tenantPrisma, new ConfigService()));
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering, makeOwnerAlerts(tenantPrisma));

  type Tenant = { companyId: string; user: AuthenticatedUser; courierId: string; warehouseId: string; customerId: string; productId: string; packagingId: string };
  let A: Tenant;
  let B: Tenant;

  const phone = () => `+99890${Math.floor(1000000 + Math.random() * 8999999)}`;
  const run = <T>(t: Tenant, fn: () => Promise<T>) => tenantPrisma.run(t.companyId, fn);
  const caught = <T>(p: Promise<T>) => p.then(() => null, (e: unknown) => e as AppErr);

  async function seed(label: string, vat: number): Promise<Tenant> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-hist-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, name: `Hist ${label}` } });
    const companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Hist ${label}`, defaultVatRate: vat } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'Op', lastName: label, phone: phone() } });
    const courier = await systemPrisma.user.create({ data: { companyId, firstName: 'Courier', lastName: label, phone: phone() } });
    const user: AuthenticatedUser = {
      id: u.id,
      companyId,
      firstName: 'Op',
      lastName: label,
      roles: ['OWNER'],
      permissions: ['orders.create', 'orders.update', 'orders.deliver', 'payments.create', 'stock.receive'],
    };
    await grantRole(companyId, courier.id, 'COURIER', ['orders.deliver']);
    const t = { companyId, user, courierId: courier.id } as Tenant;
    await tenantPrisma.run(companyId, async (tx) => {
      t.warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'WH' } })).id;
      t.productId = (await tx.product.create({ data: { companyId, sku: `HIST-${label}`, name: `Hist ${label}`, baseUnit: 'dona', vatRate: vat } })).id;
      t.packagingId = (await tx.productPackaging.create({ data: { productId: t.productId, name: 'dona', qtyInBaseUnit: '1', isDefault: true } })).id;
      const pl = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId: t.productId, price: '1000.00' } });
      t.customerId = (await tx.customer.create({ data: { companyId, code: `HIST-${label}-${Date.now()}`, name: `Cust ${label}` } })).id;
    });
    await tenantPrisma.run(companyId, () => stock.receive({ productId: t.productId, warehouseId: t.warehouseId, qty: 1000 }, user));
    return t;
  }

  const create = (t: Tenant, qty: number) => run(t, () => sales.create({ customerId: t.customerId, lines: [{ productId: t.productId, packagingId: t.packagingId, qty }] }, t.user));
  const setMin = (t: Tenant, minPrice: string | null) => tenantPrisma.run(t.companyId, (tx) => tx.product.update({ where: { id: t.productId }, data: { minPrice } }));

  beforeAll(async () => {
    A = await seed('A', 12);
    B = await seed('B', 12);
  });
  afterEach(async () => {
    await setMin(A, null);
    await systemPrisma.company.update({ where: { id: A.companyId }, data: { defaultVatRate: 12 } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('ADR-059b + PO-A: assignCourier on SUBMITTED order (minPrice raised) => 409 SALES_ORDER_COURIER_ASSIGN_INVALID_STATUS (assign never confirms); no reservation, no StockMovement, status unchanged', async () => {
    const order = await create(A, 3);
    await setMin(A, '1500.00');
    const state = () =>
      tenantPrisma.run(A.companyId, async (tx) => ({
        movements: await tx.stockMovement.count(),
        level: (await tx.stockLevel.findFirstOrThrow({ where: { productId: A.productId, warehouseId: A.warehouseId } })).reserved.toString(),
        order: JSON.stringify(await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } })),
      }));
    const before = await state();
    const err = await caught(run(A, () => sales.assignCourier(order.id, { courierId: A.courierId }, A.user)));
    expect(err?.getStatus()).toBe(409);
    expect(err?.getResponse().code).toBe('SALES_ORDER_COURIER_ASSIGN_INVALID_STATUS');
    expect(err?.getResponse().details).toMatchObject({ status: 'SUBMITTED' });
    expect(await state()).toEqual(before);
    expect(JSON.parse(before.order).status).toBe('SUBMITTED');
    await setMin(A, null);
  });

  it('ADR-059: delivered order + invoice are byte-identical after minPrice raised and Company.defaultVatRate changed; later payment FIFO allocation unchanged', async () => {
    const o1 = await create(A, 2);
    const o2 = await create(A, 5);
    for (const o of [o1, o2]) {
      await run(A, () => sales.confirm(o.id, A.user));
      await run(A, () => sales.deliver(o.id, A.user));
    }
    const snap = () =>
      tenantPrisma.run(A.companyId, async (tx) =>
        JSON.stringify({
          orders: await tx.salesOrder.findMany({ where: { id: { in: [o1.id, o2.id] } }, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
          invoices: await tx.invoice.findMany({ where: { customerId: A.customerId }, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
          movements: await tx.stockMovement.findMany({ where: { productId: A.productId }, orderBy: { id: 'asc' } }),
        }),
      );
    const before = await snap();
    const invoices = await tenantPrisma.run(A.companyId, (tx) => tx.invoice.findMany({ where: { customerId: A.customerId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    expect(invoices).toHaveLength(2);

    await setMin(A, '99999.00');
    await systemPrisma.company.update({ where: { id: A.companyId }, data: { defaultVatRate: 20 } });
    expect(await snap()).toBe(before);

    const total0 = invoices[0]!.total;
    const pay = total0.plus('100.00');
    const payment = await run(A, () => payments.create({ customerId: A.customerId, amount: Number(pay.toFixed(2)), method: 'TRANSFER' as never }, A.user));
    const allocs = await tenantPrisma.run(A.companyId, (tx) => tx.paymentAllocation.findMany({ where: { paymentId: payment.id } }));
    const byInvoice = new Map(allocs.map((a) => [a.invoiceId, a.amount.toFixed(2)]));
    expect(byInvoice.get(invoices[0]!.id)).toBe(total0.toFixed(2));
    expect(byInvoice.get(invoices[1]!.id)).toBe('100.00');
    const afterPay = JSON.parse(await snap());
    expect(afterPay.orders).toEqual(JSON.parse(before).orders);
    expect(afterPay.movements).toEqual(JSON.parse(before).movements);
    await setMin(A, null);
    await systemPrisma.company.update({ where: { id: A.companyId }, data: { defaultVatRate: 12 } });
  });

  it('tenant isolation: B minPrice and defaultVatRate never affect A; A cannot order B product', async () => {
    await setMin(B, '999999.00');
    await systemPrisma.company.update({ where: { id: B.companyId }, data: { defaultVatRate: 0 } });

    const order = await create(A, 1);
    expect(order.lines[0]!.unitPrice.toFixed(2)).toBe('1000.00');
    expect(order.lines[0]!.lineTotal.toFixed(2)).toBe('1120.00'); // A product VAT 12 untouched
    const confirmed = await run(A, () => sales.confirm(order.id, A.user));
    expect(confirmed.status).toBe('CONFIRMED');

    const cross = await caught(run(A, () => sales.create({ customerId: A.customerId, lines: [{ productId: B.productId, packagingId: B.packagingId, qty: 1 }] }, A.user)));
    expect(cross).not.toBeNull();
    expect(cross?.getResponse().code).not.toBe('ORDER_PRICE_BELOW_MIN');

    const bMin = await tenantPrisma.run(B.companyId, (tx) => tx.product.findUniqueOrThrow({ where: { id: B.productId } }));
    expect(bMin.minPrice?.toFixed(2)).toBe('999999.00'); // B's own setting is intact
    const aCompany = await systemPrisma.company.findUniqueOrThrow({ where: { id: A.companyId } });
    expect(aCompany.defaultVatRate.toString()).toBe('12');
  });
});
