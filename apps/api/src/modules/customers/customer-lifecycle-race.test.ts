import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SalesService } from '../sales/sales.service';
import { StockService } from '../stock/stock.service';
import { CustomersService } from './customers.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';

/** ADR-061c concurrency: real parallel transactions on real Postgres; invariants, not timings. */
describe('Customer lifecycle races (ADR-061)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const docNumbering = new DocumentNumberingService();
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, new NotificationsService(tenantPrisma, new ConfigService()));
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering, makeOwnerAlerts(tenantPrisma));
  const tag = randomUUID().slice(0, 6);
  const ROUNDS = 8;

  let companyId: string;
  let owner: AuthenticatedUser;
  let productId: string;
  let packagingId: string;
  let seq = 0;

  const run = <T>(fn: Parameters<TenantPrismaService['run']>[1]) => tenantPrisma.run(companyId, fn) as Promise<T>;
  const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { response?: { code?: string }; code?: string; message?: string }) => e.response?.code ?? e.code ?? String(e.message));
  const newCustomer = () => run<{ id: string }>((tx) => tx.customer.create({ data: { companyId, code: `RC-${tag}-${++seq}`, name: `Race ${seq}` } }));
  const deletedAt = async (id: string) => (await run<{ deletedAt: Date | null }>((tx) => tx.customer.findUniqueOrThrow({ where: { id } }))).deletedAt;
  const auditCount = (entityId: string, action: string) => run<unknown[]>((tx) => tx.auditLog.findMany({ where: { entityId, action } })).then((r) => r.length);
  const noDeadlock = (c: string) => expect(['40P01', 'P2034']).not.toContain(c);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-clife-race-${Date.now()}-${tag}`, name: 'Life race' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Life race Co' } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'Own', lastName: 'Race', phone: `+99893${Math.floor(1_000_000 + Math.random() * 8_000_000)}` } });
    owner = { id: u.id, companyId, firstName: 'Own', lastName: 'Race', roles: ['OWNER'], permissions: ['customers.restore', 'orders.update'] };
    await run(async (tx) => {
      const wh = await tx.warehouse.create({ data: { companyId, name: 'Race WH' } });
      const product = await tx.product.create({ data: { companyId, sku: `RACE-${tag}`, name: 'Race P', baseUnit: 'dona', vatRate: 12 } });
      productId = product.id;
      packagingId = (await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: 1, isDefault: true } })).id;
      const pl = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '1000' } });
      return wh;
    });
    const wh = await run<{ id: string }>((tx) => tx.warehouse.findFirstOrThrow({ where: { companyId } }));
    await run(() => stock.receive({ productId, warehouseId: wh.id, qty: 10_000 }, owner));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('delete vs order create: exactly one wins — never a live order on a deleted customer', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await newCustomer();
      const [del, ord] = await Promise.all([
        code(run(() => customers.remove(c.id, owner))),
        code(run(() => sales.create({ customerId: c.id, lines: [{ productId, packagingId, qty: 1 }] }, owner))),
      ]);
      noDeadlock(del);
      noDeadlock(ord);
      const orders = await run<unknown[]>((tx) => tx.salesOrder.findMany({ where: { customerId: c.id } }));
      const isDeleted = (await deletedAt(c.id)) !== null;
      if (del === 'OK') {
        expect(isDeleted).toBe(true);
        expect(orders).toHaveLength(0);
        expect(ord).toBe('CUSTOMER_NOT_FOUND');
      } else {
        expect(isDeleted).toBe(false);
        expect(del).toBe('CUSTOMER_HAS_OPEN_OBLIGATIONS');
        expect(ord).toBe('OK');
        expect(orders).toHaveLength(1);
      }
      expect(await auditCount(c.id, 'customer.delete')).toBe(del === 'OK' ? 1 : 0);
    }
  });

  it('delete vs payment create: no payment lands on a deleted customer; a landed payment blocks the delete', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await newCustomer();
      const [del, pay] = await Promise.all([
        code(run(() => customers.remove(c.id, owner))),
        code(run(() => payments.create({ customerId: c.id, amount: 100, method: 'CASH' } as never, owner))),
      ]);
      noDeadlock(del);
      noDeadlock(pay);
      const rows = await run<unknown[]>((tx) => tx.payment.findMany({ where: { customerId: c.id } }));
      const isDeleted = (await deletedAt(c.id)) !== null;
      expect(isDeleted && rows.length > 0).toBe(false); // the bypass this ADR closes
      if (del === 'OK') expect(pay).toBe('CUSTOMER_NOT_FOUND');
      else {
        expect(pay).toBe('OK');
        expect(['CUSTOMER_HAS_CREDIT_BALANCE', 'CUSTOMER_HAS_OUTSTANDING_BALANCE', 'CUSTOMER_HAS_OPEN_OBLIGATIONS']).toContain(del);
      }
    }
  });

  it('delete vs allocate: allocate never posts on a deleted customer; ledger stays consistent', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await newCustomer();
      const { inv, pay } = await run<{ inv: { id: string }; pay: { id: string } }>(async (tx) => ({
        inv: await tx.invoice.create({ data: { companyId, number: `INV-RC-${tag}-${++seq}`, customerId: c.id, total: '100.00', status: 'OPEN' } }),
        pay: await tx.payment.create({ data: { companyId, number: `PAY-RC-${tag}-${++seq}`, customerId: c.id, amount: '100.00', method: 'CASH' } }),
      }));
      const [del, alloc] = await Promise.all([
        code(run(() => customers.remove(c.id, owner))),
        code(run(() => payments.allocate(pay.id, { allocations: [{ invoiceId: inv.id, amount: '100.00' }] } as never, owner))),
      ]);
      noDeadlock(del);
      noDeadlock(alloc);
      // debt + advance exist before the race => delete can only succeed after allocation settled both to 0
      const allocs = await run<unknown[]>((tx) => tx.paymentAllocation.findMany({ where: { paymentId: pay.id } }));
      const isDeleted = (await deletedAt(c.id)) !== null;
      if (isDeleted) {
        expect(alloc).toBe('OK'); // allocation committed first, then delete saw a zero ledger
        expect(allocs).toHaveLength(1);
      } else {
        expect(del).not.toBe('OK');
      }
      if (alloc !== 'OK') expect(allocs).toHaveLength(0);
      expect(allocs.length).toBeLessThanOrEqual(1);
    }
  });

  it('restore vs restore: exactly one succeeds, one restore audit row, the loser is 404', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await newCustomer();
      await run(() => customers.remove(c.id, owner));
      const results = await Promise.all([code(run(() => customers.restore(c.id, owner))), code(run(() => customers.restore(c.id, owner)))]);
      results.forEach(noDeadlock);
      expect(results.filter((r) => r === 'OK')).toHaveLength(1);
      expect(results.filter((r) => r === 'CUSTOMER_NOT_FOUND')).toHaveLength(1);
      expect(await deletedAt(c.id)).toBeNull();
      expect(await auditCount(c.id, 'customer.restore')).toBe(1);
    }
  });

  it('delete vs delete: exactly one delete audit row', async () => {
    const c = await newCustomer();
    const results = await Promise.all([code(run(() => customers.remove(c.id, owner))), code(run(() => customers.remove(c.id, owner)))]);
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(await auditCount(c.id, 'customer.delete')).toBe(1);
  });
});
