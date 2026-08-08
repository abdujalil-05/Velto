import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../../customers/customers.service';
import { AllocationExceedsInvoiceException, AllocationExceedsPaymentException, InvoiceNotFoundException } from '../finance-exceptions';
import { PaymentsService } from './payments.service';

describe('PaymentsService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const docNumbering = new DocumentNumberingService();
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-payments-${Date.now()}`, name: 'Payments Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Payments Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Cash', lastName: 'Ier', phone: '+998900000010' },
    });
    user = {
      id: dbUser.id,
      companyId,
      firstName: 'Cash',
      lastName: 'Ier',
      roles: ['CASHIER'],
      permissions: ['payments.create'],
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  let invoiceSeq = 1;

  async function createCustomerWithInvoices(invoiceTotals: { total: string; ageDays: number }[]) {
    const { customer } = await tenantPrisma.run(companyId, () =>
      customers.create({ code: `PAY-CUST-${Date.now()}-${Math.random()}`, name: 'Payments Test Customer' }, user),
    );
    const customerId = (customer as { id: string }).id;

    const invoiceIds: string[] = [];
    await tenantPrisma.run(companyId, async (tx) => {
      for (const { total, ageDays } of invoiceTotals) {
        const createdAt = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
        const invoice = await tx.invoice.create({
          data: {
            companyId,
            number: `PAY-TEST-INV-${Date.now()}-${invoiceSeq++}`,
            customerId,
            total,
            status: 'OPEN',
            createdAt,
          },
        });
        invoiceIds.push(invoice.id);
      }
    });
    return { customerId, invoiceIds };
  }

  it('auto-allocates FIFO across the oldest open invoices first', async () => {
    const { customerId, invoiceIds } = await createCustomerWithInvoices([
      { total: '30000', ageDays: 10 },
      { total: '50000', ageDays: 20 }, // oldest — should be settled first
      { total: '40000', ageDays: 5 },
    ]);

    const payment = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 70000, method: 'CASH' }, user),
    );

    expect(payment.allocations).toHaveLength(2);
    const allocByInvoice = new Map(payment.allocations.map((a) => [a.invoiceId, a.amount.toString()]));
    expect(allocByInvoice.get(invoiceIds[1]!)).toBe('50000');
    expect(allocByInvoice.get(invoiceIds[0]!)).toBe('20000');
    expect(allocByInvoice.has(invoiceIds[2]!)).toBe(false);

    const updatedInvoices = await tenantPrisma.run(companyId, (tx) =>
      tx.invoice.findMany({ where: { id: { in: invoiceIds } } }),
    );
    const statusById = new Map(updatedInvoices.map((i) => [i.id, i.status]));
    expect(statusById.get(invoiceIds[1]!)).toBe('PAID');
    expect(statusById.get(invoiceIds[0]!)).toBe('PARTIALLY_PAID');
    expect(statusById.get(invoiceIds[2]!)).toBe('OPEN');

    const customer = await tenantPrisma.run(companyId, (tx) =>
      tx.customer.findUniqueOrThrow({ where: { id: customerId } }),
    );
    // Balance = (30000 + 50000 + 40000) - 70000 = 50000
    expect(customer.cachedBalance.toString()).toBe('50000');
  });

  it('supports manual allocation, overriding FIFO order', async () => {
    const { customerId, invoiceIds } = await createCustomerWithInvoices([
      { total: '10000', ageDays: 1 },
      { total: '20000', ageDays: 30 },
    ]);

    const payment = await tenantPrisma.run(companyId, () =>
      payments.create(
        {
          customerId,
          amount: 15000,
          method: 'CARD',
          allocations: [
            { invoiceId: invoiceIds[0]!, amount: 10000 },
            { invoiceId: invoiceIds[1]!, amount: 5000 },
          ],
        },
        user,
      ),
    );

    expect(payment.allocations).toHaveLength(2);
    const allocByInvoice = new Map(payment.allocations.map((a) => [a.invoiceId, a.amount.toString()]));
    expect(allocByInvoice.get(invoiceIds[0]!)).toBe('10000');
    expect(allocByInvoice.get(invoiceIds[1]!)).toBe('5000');
  });

  it('rejects manual allocations that exceed the payment amount', async () => {
    const { customerId, invoiceIds } = await createCustomerWithInvoices([{ total: '10000', ageDays: 1 }]);

    await expect(
      tenantPrisma.run(companyId, () =>
        payments.create(
          { customerId, amount: 5000, method: 'CASH', allocations: [{ invoiceId: invoiceIds[0]!, amount: 6000 }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(AllocationExceedsPaymentException);
  });

  it('rejects a manual allocation that exceeds a single invoice outstanding balance', async () => {
    const { customerId, invoiceIds } = await createCustomerWithInvoices([{ total: '10000', ageDays: 1 }]);

    await expect(
      tenantPrisma.run(companyId, () =>
        payments.create(
          { customerId, amount: 20000, method: 'CASH', allocations: [{ invoiceId: invoiceIds[0]!, amount: 20000 }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(AllocationExceedsInvoiceException);
  });

  it('resubmitting the same clientId returns the original payment (10.4 offline idempotency)', async () => {
    const { customerId } = await createCustomerWithInvoices([{ total: '10000', ageDays: 1 }]);
    const clientId = randomUUID();

    const first = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 5000, method: 'CASH', clientId }, user),
    );
    const second = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 999999, method: 'CASH', clientId }, user),
    );

    expect(second.id).toBe(first.id);
    expect(second.amount.toString()).toBe(first.amount.toString());
  });

  it('leaves an over-payment unallocated once every open invoice is settled', async () => {
    const { customerId, invoiceIds } = await createCustomerWithInvoices([{ total: '10000', ageDays: 1 }]);

    const payment = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 15000, method: 'CASH' }, user),
    );

    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0]?.amount.toString()).toBe('10000');
    expect(payment.amount.toString()).toBe('15000');

    const invoice = await tenantPrisma.run(companyId, (tx) =>
      tx.invoice.findUniqueOrThrow({ where: { id: invoiceIds[0]! } }),
    );
    expect(invoice.status).toBe('PAID');
  });

  it('under concurrent payments against the same invoice, allocations never exceed its total (row lock, no over-allocation)', async () => {
    const { customerId, invoiceIds } = await createCustomerWithInvoices([{ total: '100000', ageDays: 1 }]);

    const attempt = () =>
      tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 100000, method: 'CASH' }, user));
    const [a, b] = await Promise.all([attempt(), attempt()]);

    const allocatedToInvoice = (result: typeof a) =>
      result.allocations
        .filter((alloc) => alloc.invoiceId === invoiceIds[0])
        .reduce((sum, alloc) => sum + Number(alloc.amount), 0);

    // Without the row lock, both payments could independently compute
    // outstanding=100000 and each allocate the full amount — 200000 against
    // a 100000 invoice. With it, the second payment's lock-protected re-read
    // sees the invoice already settled and allocates nothing further to it.
    expect(allocatedToInvoice(a) + allocatedToInvoice(b)).toBe(100000);

    const invoice = await tenantPrisma.run(companyId, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoiceIds[0]! } }));
    expect(invoice.status).toBe('PAID');
  });

  it('refuses to manually allocate against a CANCELLED invoice', async () => {
    const { customerId, invoiceIds } = await createCustomerWithInvoices([{ total: '10000', ageDays: 1 }]);
    await tenantPrisma.run(companyId, (tx) =>
      tx.invoice.update({ where: { id: invoiceIds[0]! }, data: { status: 'CANCELLED' } }),
    );

    await expect(
      tenantPrisma.run(companyId, () =>
        payments.create(
          { customerId, amount: 5000, method: 'CASH', allocations: [{ invoiceId: invoiceIds[0]!, amount: 5000 }] },
          user,
        ),
      ),
    ).rejects.toBeInstanceOf(InvoiceNotFoundException);
  });

  it('list() filters by from/to (createdAt) and collectedBy, leaving unbounded callers unaffected', async () => {
    const { customerId } = await createCustomerWithInvoices([{ total: '15000', ageDays: 1 }]);
    const payment = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 15000, method: 'CASH' }, user),
    );

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const todayList = await tenantPrisma.run(companyId, () =>
      payments.list({ page: 1, pageSize: 100, collectedBy: user.id, from: today, to: today }),
    );
    expect(todayList.data.map((p) => p.id)).toContain(payment.id);

    const futureList = await tenantPrisma.run(companyId, () =>
      payments.list({ page: 1, pageSize: 100, collectedBy: user.id, from: tomorrow, to: tomorrow }),
    );
    expect(futureList.data.map((p) => p.id)).not.toContain(payment.id);

    const unbounded = await tenantPrisma.run(companyId, () => payments.list({ page: 1, pageSize: 100, customerId }));
    expect(unbounded.data.map((p) => p.id)).toContain(payment.id);
  });
});
