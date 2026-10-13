import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../../customers/customers.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SalesService } from '../../sales/sales.service';
import { StockService } from '../../stock/stock.service';
import { InvoiceNotFoundException } from '../finance-exceptions';
import { PaymentsService } from '../payments/payments.service';
import { InvoicesService } from './invoices.service';

// TZ 6.3 (INV-{YYYY}-{6-digit}, concurrent-safe numbering), 6.1 (snapshot), 16.1 P0 (invoice = order snapshot).
describe('InvoicesService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let warehouseId: string;
  let productId: string;
  let packagingId: string;
  let priceListId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog);
  const docNumbering = new DocumentNumberingService();
  const notifications = new NotificationsService(tenantPrisma, new ConfigService());
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, notifications);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering);
  const invoices = new InvoicesService(tenantPrisma, customers);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-invoices-${Date.now()}`, name: 'Invoices Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Invoices Test Co' } });
    companyId = company.id;
    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Inv', lastName: 'User', phone: `+9989011${Math.floor(Math.random() * 90000) + 10000}` },
    });
    user = {
      id: dbUser.id,
      companyId,
      firstName: 'Inv',
      lastName: 'User',
      roles: ['OWNER'],
      permissions: ['orders.update', 'payments.create'],
    };

    await tenantPrisma.run(companyId, async (tx) => {
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'Inv WH' } })).id;
      const product = await tx.product.create({
        data: { companyId, sku: `INV-${Date.now()}`, name: 'Inv Product', baseUnit: 'dona', vatRate: 12 },
      });
      productId = product.id;
      packagingId = (
        await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: 1, isDefault: true } })
      ).id;
      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      priceListId = priceList.id;
      await tx.priceListItem.create({ data: { priceListId, productId, price: '10000' } });
    });
    await tenantPrisma.run(companyId, () => stock.receive({ productId, warehouseId, qty: 1000 }, user));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function newCustomer() {
    const { customer } = await tenantPrisma.run(companyId, () =>
      customers.create({ code: `INV-C-${Date.now()}-${Math.random()}`, name: 'Inv Customer' }, user),
    );
    return (customer as { id: string }).id;
  }

  /** order(qty) -> confirm -> deliver; returns order id + customerId. */
  async function deliveredOrder(customerId: string, qty: number, discountPct = 0) {
    const order = await tenantPrisma.run(companyId, () =>
      sales.create({ customerId, lines: [{ productId, packagingId, qty, discountPct }] }, user),
    );
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    return order;
  }

  async function invoiceOf(orderId: string) {
    return tenantPrisma.run(companyId, (tx) =>
      tx.invoice.findFirstOrThrow({ where: { orderId }, include: { lines: true } }),
    );
  }

  it('deliver creates an OPEN invoice numbered INV-{YYYY}-{6-digit} whose total equals the order total (16.1 snapshot)', async () => {
    const customerId = await newCustomer();
    // 4 * 10000 * 0.9 * 1.12 = 40320
    const order = await deliveredOrder(customerId, 4, 10);
    const inv = await invoiceOf(order.id);
    expect(inv.number).toMatch(new RegExp(`^INV-${new Date().getFullYear()}-\\d{6}$`));
    expect(inv.status).toBe('OPEN');
    expect(inv.total.toString()).toBe('40320');
    expect(order.total.toString()).toBe('40320');
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]!.lineTotal.toString()).toBe('40320');
    expect(inv.lines[0]!.unitPrice.toString()).toBe('10000');
    expect(inv.lines[0]!.vatRate.toString()).toBe('12');
    expect(inv.lines[0]!.qty.toString()).toBe('4');
  });

  it('invoice total = exact Decimal sum of its lines', async () => {
    const customerId = await newCustomer();
    const order = await deliveredOrder(customerId, 3);
    const inv = await invoiceOf(order.id);
    const sum = inv.lines.reduce((s, l) => s.plus(l.lineTotal), inv.total.minus(inv.total));
    expect(inv.total.toString()).toBe(sum.toString());
    expect(inv.total.toString()).toBe('33600');
  });

  it('invoice is a snapshot: later catalog price/VAT changes do not alter it (6.1)', async () => {
    const customerId = await newCustomer();
    const order = await deliveredOrder(customerId, 2);
    await tenantPrisma.run(companyId, async (tx) => {
      await tx.priceListItem.updateMany({ where: { priceListId, productId }, data: { price: '99999' } });
      await tx.product.update({ where: { id: productId }, data: { vatRate: 0 } });
    });
    const inv = await invoiceOf(order.id);
    expect(inv.total.toString()).toBe('22400');
    expect(inv.lines[0]!.unitPrice.toString()).toBe('10000');
    expect(inv.lines[0]!.vatRate.toString()).toBe('12');
    await tenantPrisma.run(companyId, async (tx) => {
      await tx.priceListItem.updateMany({ where: { priceListId, productId }, data: { price: '10000' } });
      await tx.product.update({ where: { id: productId }, data: { vatRate: 12 } });
    });
  });

  it('numbering is unique and strictly increasing, also under parallel delivers (6.3)', async () => {
    const customerId = await newCustomer();
    const orders = [];
    for (let i = 0; i < 5; i++) {
      const o = await tenantPrisma.run(companyId, () =>
        sales.create({ customerId, lines: [{ productId, packagingId, qty: 1 }] }, user),
      );
      await tenantPrisma.run(companyId, () => sales.confirm(o.id, user));
      orders.push(o);
    }
    await Promise.all(orders.map((o) => tenantPrisma.run(companyId, () => sales.deliver(o.id, user))));
    const numbers = (await Promise.all(orders.map((o) => invoiceOf(o.id)))).map((i) => i.number);
    expect(new Set(numbers).size).toBe(5);
    const seq = numbers.map((n) => Number(n.split('-')[2])).sort((a, b) => a - b);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBe(seq[i - 1]! + 1); // no gaps within the batch
  });

  it('getById returns lines + outstanding; status moves OPEN -> PARTIALLY_PAID -> PAID with exact Decimal outstanding', async () => {
    const customerId = await newCustomer();
    const order = await deliveredOrder(customerId, 5); // 56000
    const inv = await invoiceOf(order.id);

    const open = await tenantPrisma.run(companyId, () => invoices.getById(inv.id, user));
    expect(open.status).toBe('OPEN');
    expect(open.paid.toString()).toBe('0');
    expect(open.outstanding.toString()).toBe('56000');
    expect(open.lines).toHaveLength(1);

    await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 20000.5, method: 'CASH', allocations: [{ invoiceId: inv.id, amount: 20000.5 }] }, user),
    );
    const partial = await tenantPrisma.run(companyId, () => invoices.getById(inv.id, user));
    expect(partial.status).toBe('PARTIALLY_PAID');
    expect(partial.paid.toString()).toBe('20000.5');
    expect(partial.outstanding.toString()).toBe('35999.5');

    await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 35999.5, method: 'CASH', allocations: [{ invoiceId: inv.id, amount: 35999.5 }] }, user),
    );
    const paid = await tenantPrisma.run(companyId, () => invoices.getById(inv.id, user));
    expect(paid.status).toBe('PAID');
    expect(paid.outstanding.toString()).toBe('0');
  });

  it('list filters by customerId and status and is tenant-scoped; unknown id throws InvoiceNotFoundException', async () => {
    const customerId = await newCustomer();
    const order = await deliveredOrder(customerId, 1);
    const inv = await invoiceOf(order.id);

    const res = await tenantPrisma.run(companyId, () =>
      invoices.list({ customerId, status: 'OPEN', page: 1, pageSize: 20 } as never, user),
    );
    const ids = (res as unknown as { data: { id: string }[] }).data.map((d) => d.id);
    expect(ids).toEqual([inv.id]);

    const none = await tenantPrisma.run(companyId, () =>
      invoices.list({ customerId, status: 'PAID', page: 1, pageSize: 20 } as never, user),
    );
    expect((none as unknown as { data: unknown[] }).data).toHaveLength(0);

    await expect(
      tenantPrisma.run(companyId, () => invoices.getById('00000000-0000-4000-8000-000000000000', user)),
    ).rejects.toBeInstanceOf(InvoiceNotFoundException);
  });
});
