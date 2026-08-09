import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  CustomerAlreadyBlockedException,
  CustomerHasOutstandingBalanceException,
  CustomerNotBlockedException,
  CustomerNotFoundException,
  DuplicateCustomerCodeException,
} from './customers-exceptions';
import { CustomersService } from './customers.service';
import type { CreateCustomerDto } from './dto/create-customer.dto';

describe('CustomersService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-customers-${Date.now()}`, name: 'Customers Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Customers Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Test', lastName: 'User', phone: '+998900000001' },
    });
    user = { id: dbUser.id, companyId, firstName: 'Test', lastName: 'User', roles: [], permissions: [] };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const dto = (code: string, overrides: Partial<CreateCustomerDto> = {}): CreateCustomerDto => ({
    code,
    name: `Customer ${code}`,
    ...overrides,
  });

  it('creates a customer with no warnings when nothing matches existing records', async () => {
    const { customer, warnings } = await tenantPrisma.run(companyId, () => customers.create(dto('C-1'), user));
    expect((customer as { code: string }).code).toBe('C-1');
    expect(warnings).toHaveLength(0);
  });

  it('rejects a duplicate customer code within the same tenant', async () => {
    await expect(tenantPrisma.run(companyId, () => customers.create(dto('C-1'), user))).rejects.toBeInstanceOf(
      DuplicateCustomerCodeException,
    );
  });

  it('block/unblock is idempotent-checked: double block and unblock-when-not-blocked both fail', async () => {
    const { customer } = await tenantPrisma.run(companyId, () => customers.create(dto('C-4'), user));
    const id = (customer as { id: string }).id;

    await expect(tenantPrisma.run(companyId, () => customers.unblock(id, user))).rejects.toBeInstanceOf(
      CustomerNotBlockedException,
    );

    const blocked = await tenantPrisma.run(companyId, () => customers.block(id, { reason: 'overdue' }, user));
    expect((blocked as { isBlocked: boolean }).isBlocked).toBe(true);

    await expect(
      tenantPrisma.run(companyId, () => customers.block(id, { reason: 'again' }, user)),
    ).rejects.toBeInstanceOf(CustomerAlreadyBlockedException);
  });

  it('computes balance as Σ(Invoice.total) − Σ(PaymentAllocation.amount), excluding cancelled invoices', async () => {
    const { customer } = await tenantPrisma.run(companyId, () => customers.create(dto('C-5'), user));
    const customerId = (customer as { id: string }).id;

    await tenantPrisma.run(companyId, async (tx) => {
      const invoice1 = await tx.invoice.create({
        data: { companyId, number: 'INV-TEST-0001', customerId, total: '100000.00', status: 'PARTIALLY_PAID' },
      });
      const payment = await tx.payment.create({
        data: { companyId, number: 'PAY-TEST-0001', customerId, amount: '40000.00', method: 'CASH' },
      });
      await tx.paymentAllocation.create({
        data: { paymentId: payment.id, invoiceId: invoice1.id, amount: '40000.00' },
      });
      // Cancelled invoice must not contribute to the balance.
      await tx.invoice.create({
        data: { companyId, number: 'INV-TEST-0002', customerId, total: '999999.00', status: 'CANCELLED' },
      });
    });

    const detail = await tenantPrisma.run(companyId, () => customers.getById(customerId, user));
    expect(detail.balance.toString()).toBe('60000');
  });

  it('remove() soft-deletes the customer, cascades to its outlets and frees the code for reuse', async () => {
    const { customer } = await tenantPrisma.run(companyId, () => customers.create(dto('C-DEL-1'), user));
    const id = (customer as { id: string }).id;
    await tenantPrisma.run(companyId, (tx) =>
      tx.outlet.create({ data: { companyId, customerId: id, name: 'Outlet A' } }),
    );

    const deleted = await tenantPrisma.run(companyId, () => customers.remove(id, user));
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isActive).toBe(false);

    const liveOutlets = await tenantPrisma.run(companyId, (tx) =>
      tx.outlet.count({ where: { customerId: id, deletedAt: null } }),
    );
    expect(liveOutlets).toBe(0);

    // Gone from every read path, and the code is available again.
    await expect(tenantPrisma.run(companyId, () => customers.getById(id, user))).rejects.toBeInstanceOf(
      CustomerNotFoundException,
    );
    const { customer: reused } = await tenantPrisma.run(companyId, () => customers.create(dto('C-DEL-1'), user));
    expect((reused as { code: string }).code).toBe('C-DEL-1');
  });

  it('remove() refuses while the customer still owes money (6.7)', async () => {
    const { customer } = await tenantPrisma.run(companyId, () => customers.create(dto('C-DEL-2'), user));
    const id = (customer as { id: string }).id;
    await tenantPrisma.run(companyId, (tx) =>
      tx.invoice.create({
        data: { companyId, number: 'INV-TEST-DEL-1', customerId: id, total: '5000.00', status: 'OPEN' },
      }),
    );

    await expect(tenantPrisma.run(companyId, () => customers.remove(id, user))).rejects.toBeInstanceOf(
      CustomerHasOutstandingBalanceException,
    );
  });

  it('SEC-023 (15.3): a SALES_AGENT only sees customers reached via their own orders/routes/visits', async () => {
    const { customer: ownCustomer } = await tenantPrisma.run(companyId, () => customers.create(dto('C-AGENT-OWN'), user));
    const { customer: otherCustomer } = await tenantPrisma.run(companyId, () => customers.create(dto('C-AGENT-OTHER'), user));
    const ownId = (ownCustomer as { id: string }).id;
    const otherId = (otherCustomer as { id: string }).id;

    const dbAgent = await systemPrisma.user.create({
      data: { companyId, firstName: 'Scoped', lastName: 'Agent', phone: '+998900000096' },
    });
    const agent: AuthenticatedUser = {
      id: dbAgent.id,
      companyId,
      firstName: 'Scoped',
      lastName: 'Agent',
      roles: ['SALES_AGENT'],
      permissions: ['customers.read'],
    };

    await tenantPrisma.run(companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'Scope Test Warehouse' } });
      await tx.salesOrder.create({
        data: {
          companyId,
          number: `SO-SCOPE-${Date.now()}`,
          customerId: ownId,
          agentId: agent.id,
          warehouseId: warehouse.id,
          status: 'SUBMITTED',
        },
      });
    });

    const list = await tenantPrisma.run(companyId, () => customers.list({ page: 1, pageSize: 100 }, agent));
    const ids = list.data.map((c) => (c as { id: string }).id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(otherId);

    const own = await tenantPrisma.run(companyId, () => customers.getById(ownId, agent));
    expect(own.id).toBe(ownId);

    await expect(tenantPrisma.run(companyId, () => customers.getById(otherId, agent))).rejects.toThrow();
    await expect(tenantPrisma.run(companyId, () => customers.getCustomerBalance(otherId, agent))).rejects.toThrow();

    // Non-agent roles remain unrestricted.
    const fullList = await tenantPrisma.run(companyId, () => customers.list({ page: 1, pageSize: 100 }, user));
    const fullIds = fullList.data.map((c) => (c as { id: string }).id);
    expect(fullIds).toEqual(expect.arrayContaining([ownId, otherId]));
  });

  it('UX-003 (9.1): list() sorts by an allow-listed column, and an unknown sortBy falls back to the default', async () => {
    await tenantPrisma.run(companyId, () => customers.create(dto('C-SORT-1', { name: 'Zebra Trading' }), user));
    await tenantPrisma.run(companyId, () => customers.create(dto('C-SORT-2', { name: 'Alpha Trading' }), user));

    const byNameAsc = await tenantPrisma.run(companyId, () =>
      customers.list({ page: 1, pageSize: 100, sortBy: 'name', sortDir: 'asc' }, user),
    );
    const names = byNameAsc.data.map((c) => (c as { name: string }).name);
    expect(names.indexOf('Alpha Trading')).toBeLessThan(names.indexOf('Zebra Trading'));

    const byNameDesc = await tenantPrisma.run(companyId, () =>
      customers.list({ page: 1, pageSize: 100, sortBy: 'name', sortDir: 'desc' }, user),
    );
    const namesDesc = byNameDesc.data.map((c) => (c as { name: string }).name);
    expect(namesDesc.indexOf('Alpha Trading')).toBeGreaterThan(namesDesc.indexOf('Zebra Trading'));

    // An unrecognized column name is not passed to Prisma as a raw field —
    // it silently falls back to the default order instead of erroring.
    await expect(
      tenantPrisma.run(companyId, () => customers.list({ page: 1, pageSize: 100, sortBy: 'bogus' }, user)),
    ).resolves.toBeDefined();
  });
});
