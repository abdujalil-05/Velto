import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';

/** ADR-061a/c + restore: real Postgres + RLS. */
describe('Customer lifecycle integrity (ADR-061)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService(), makeOwnerAlerts(tenantPrisma));
  const tag = randomUUID().slice(0, 6);

  let companyId: string;
  let companyB: string;
  let owner: AuthenticatedUser;
  let ownerB: AuthenticatedUser;
  let director: AuthenticatedUser;
  let warehouseId: string;

  const run = <T>(fn: (tx: TenantClient) => Promise<T>, cid = companyId) => tenantPrisma.run(cid, fn);
  const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: { response?: { code?: string } }) => e.response?.code ?? String(e));
  const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: { response?: { code?: string; details?: unknown } }) => e.response);

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-cust-life-${label}-${Date.now()}-${tag}`, name: `Life ${label}` } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Life ${label}` } });
    const mk = async (role: string, permissions: string[]): Promise<AuthenticatedUser> => {
      const u = await systemPrisma.user.create({
        data: { companyId: company.id, firstName: role, lastName: label, phone: `+99893${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
      });
      return { id: u.id, companyId: company.id, firstName: role, lastName: label, roles: [role], permissions };
    };
    return { companyId: company.id, owner: await mk('OWNER', ['customers.restore']), director: await mk('SALES_DIRECTOR', []) };
  }

  let seq = 0;
  const newCustomer = async (cid = companyId, extra: { isActive?: boolean } = {}) =>
    run((tx) => tx.customer.create({ data: { companyId: cid, code: `L-${tag}-${++seq}`, name: `Life ${seq}`, ...extra } }), cid);
  const softDelete = (id: string) => run((tx) => tx.customer.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } }));
  const auditRows = (entityId: string, action: string, cid = companyId) =>
    run((tx) => tx.auditLog.findMany({ where: { entityId, action }, orderBy: { createdAt: 'asc' } }), cid);
  const ledgerSnapshot = (customerId: string) =>
    run(async (tx) => ({
      payments: await tx.payment.findMany({ where: { customerId }, orderBy: { id: 'asc' } }),
      allocations: await tx.paymentAllocation.findMany({ where: { payment: { customerId } }, orderBy: { id: 'asc' } }),
      reversals: await tx.paymentReversal.count({ where: { payment: { customerId } } }),
      invoices: await tx.invoice.findMany({ where: { customerId }, orderBy: { id: 'asc' } }),
      cached: (await tx.customer.findUniqueOrThrow({ where: { id: customerId } })).cachedBalance.toFixed(2),
    }));
  const order = (customerId: string, status: string) =>
    run((tx) =>
      tx.salesOrder.create({
        data: {
          companyId,
          number: `SO-L-${tag}-${++seq}`,
          customerId,
          warehouseId,
          status: status as never,
          ...(status === 'CANCELLED' ? { cancelReason: 'test', cancelledAt: new Date() } : {}),
        },
      }),
    );

  beforeAll(async () => {
    const a = await seedCompany('A');
    companyId = a.companyId;
    owner = a.owner;
    director = a.director;
    const b = await seedCompany('B');
    companyB = b.companyId;
    ownerB = b.owner;
    warehouseId = (await run((tx) => tx.warehouse.create({ data: { companyId, name: `Life WH ${tag}` } }))).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  describe('061a: soft-deleted customer freezes the ledger', () => {
    it('allocate and reverse are rejected with CUSTOMER_DELETED, ledger untouched, rejection audited in its own tx', async () => {
      const c = await newCustomer();
      const { inv, pay } = await run(async (tx) => {
        const inv = await tx.invoice.create({ data: { companyId, number: `INV-L-${tag}-${++seq}`, customerId: c.id, total: '1000.00', status: 'OPEN' } });
        const pay = await tx.payment.create({ data: { companyId, number: `PAY-L-${tag}-${++seq}`, customerId: c.id, amount: '1000.00', method: 'CASH' } });
        return { inv, pay };
      });
      await softDelete(c.id); // legacy delete (pre-061) that left an open advance + invoice
      const before = await ledgerSnapshot(c.id);

      const allocErr = await errOf(run(() => payments.allocate(pay.id, { allocations: [{ invoiceId: inv.id, amount: '400.00' }] }, owner)));
      expect(allocErr).toMatchObject({ code: 'CUSTOMER_DELETED', details: { customerIds: [c.id] } });
      expect(await codeOf(run(() => payments.reverse(pay.id, 'wrong customer', owner)))).toBe('CUSTOMER_DELETED');

      expect(await ledgerSnapshot(c.id)).toEqual(before);
      const allocAudit = await auditRows(pay.id, 'payment.allocate_rejected');
      const revAudit = await auditRows(pay.id, 'payment.reverse_rejected');
      expect(allocAudit).toHaveLength(1);
      expect(revAudit).toHaveLength(1);
      expect(allocAudit[0]!.newValue).toMatchObject({ reason: 'CUSTOMER_DELETED' });
      expect(await auditRows(pay.id, 'payment.allocate')).toHaveLength(0);

      // Restore → allocate works, the earlier posted rows are unchanged (append-only).
      await run(() => customers.restore(c.id, owner));
      const allocated = await run(() => payments.allocate(pay.id, { allocations: [{ invoiceId: inv.id, amount: '400.00' }] }, owner));
      expect(allocated.advance).toBe('600');
      const after = await ledgerSnapshot(c.id);
      expect(after.payments).toEqual(before.payments);
      expect(after.allocations).toHaveLength(1);
      expect(after.cached).toBe('0.00');
    });
  });

  describe('061c: delete blockers', () => {
    it.each(['DRAFT', 'SUBMITTED', 'CONFIRMED', 'SHIPPED', 'DELIVERED'])('an order in %s blocks delete with per-status counts; audited', async (status) => {
      const c = await newCustomer();
      await order(c.id, status);
      await order(c.id, 'CLOSED');
      const err = await errOf(run(() => customers.remove(c.id, owner)));
      expect(err).toMatchObject({
        code: 'CUSTOMER_HAS_OPEN_OBLIGATIONS',
        details: { blockers: { orders: { [status]: 1 }, pendingHandover: 0, debt: '0.00', advance: '0.00' } },
      });
      expect(Object.keys((err!.details as { blockers: { orders: object } }).blockers.orders)).toEqual([status]);
      expect((await run((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).toBeNull();
      const audit = await auditRows(c.id, 'customer.delete_rejected');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.newValue).toMatchObject({ reason: 'CUSTOMER_HAS_OPEN_OBLIGATIONS' });
    });

    it('CLOSED/CANCELLED pass; DELIVERED blocks until closed', async () => {
      const c = await newCustomer();
      await order(c.id, 'CANCELLED');
      const delivered = await order(c.id, 'DELIVERED');
      expect(await codeOf(run(() => customers.remove(c.id, owner)))).toBe('CUSTOMER_HAS_OPEN_OBLIGATIONS');
      await run((tx) => tx.salesOrder.update({ where: { id: delivered.id }, data: { status: 'CLOSED' } }));
      expect(await codeOf(run(() => customers.remove(c.id, owner)))).toBe('OK');
      expect(await auditRows(c.id, 'customer.delete')).toHaveLength(1);
    });

    it('debt and advance that net to 0 still block; PENDING_HANDOVER blocks with blockers detail', async () => {
      const c = await newCustomer();
      await run(async (tx) => {
        await tx.invoice.create({ data: { companyId, number: `INV-L-${tag}-${++seq}`, customerId: c.id, total: '250.00', status: 'OPEN' } });
        await tx.payment.create({ data: { companyId, number: `PAY-L-${tag}-${++seq}`, customerId: c.id, amount: '250.00', method: 'CASH' } });
      });
      expect(await errOf(run(() => customers.remove(c.id, owner)))).toMatchObject({
        code: 'CUSTOMER_HAS_OPEN_OBLIGATIONS',
        details: { blockers: { debt: '250.00', advance: '250.00' } },
      });

      const d = await newCustomer();
      await run((tx) =>
        tx.payment.create({
          data: { companyId, number: `PAY-L-${tag}-${++seq}`, customerId: d.id, amount: '90.00', method: 'CASH', status: 'PENDING_HANDOVER', collectedBy: director.id },
        }),
      );
      expect(await errOf(run(() => customers.remove(d.id, owner)))).toMatchObject({
        code: 'CUSTOMER_HAS_PENDING_HANDOVER',
        details: { count: 1, blockers: { pendingHandover: 1 } },
      });

      const e = await newCustomer();
      await run((tx) => tx.invoice.create({ data: { companyId, number: `INV-L-${tag}-${++seq}`, customerId: e.id, total: '10.00', status: 'OPEN' } }));
      expect(await errOf(run(() => customers.remove(e.id, owner)))).toMatchObject({
        code: 'CUSTOMER_HAS_OUTSTANDING_BALANCE',
        details: { balance: '10.00', blockers: { debt: '10.00' } },
      });
    });

    it('cross-tenant delete → 404, audited only in the caller tenant', async () => {
      const c = await newCustomer();
      expect(await codeOf(run(() => customers.remove(c.id, ownerB), companyB))).toBe('CUSTOMER_NOT_FOUND');
      expect((await run((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).toBeNull();
      expect(await auditRows(c.id, 'customer.delete_rejected', companyB)).toHaveLength(1);
      expect(await auditRows(c.id, 'customer.delete_rejected')).toHaveLength(0);
    });
  });

  describe('restore', () => {
    it('requires customers.restore (route metadata; deleted list 403 without it)', async () => {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, CustomersController.prototype.restore)).toBe('customers.restore');
      expect(await codeOf(run(() => customers.list({ page: 1, pageSize: 20, deleted: true } as never, director)))).toBe('PERMISSION_DENIED');
      const audit = await auditRows(director.id, 'customer.list_deleted_rejected');
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit[0]!.newValue).toMatchObject({ reason: 'PERMISSION_DENIED' });
    });

    it('restores isActive from the delete audit and exactly the cascaded outlets; audited; listed under ?deleted=true until then', async () => {
      const c = await newCustomer(companyId, { isActive: true });
      const { o1, o2, old } = await run(async (tx) => ({
        o1: await tx.outlet.create({ data: { companyId, customerId: c.id, name: 'active' } }),
        o2: await tx.outlet.create({ data: { companyId, customerId: c.id, name: 'inactive', isActive: false } }),
        old: await tx.outlet.create({ data: { companyId, customerId: c.id, name: 'deleted earlier', deletedAt: new Date(Date.now() - 86_400_000), isActive: false } }),
      }));
      await run(() => customers.remove(c.id, owner));

      const listed = await run(() => customers.list({ page: 1, pageSize: 100, deleted: true } as never, owner));
      expect((listed.data as Array<{ id: string }>).map((r) => r.id)).toContain(c.id);

      const restored = await run(() => customers.restore(c.id, owner));
      expect(restored.deletedAt).toBeNull();
      expect(restored.isActive).toBe(true);
      const outlets = await run((tx) => tx.outlet.findMany({ where: { customerId: c.id } }));
      const byId = new Map(outlets.map((o) => [o.id, o]));
      expect(byId.get(o1.id)).toMatchObject({ deletedAt: null, isActive: true });
      expect(byId.get(o2.id)).toMatchObject({ deletedAt: null, isActive: false });
      expect(byId.get(old.id)!.deletedAt).not.toBeNull();
      const audit = await auditRows(c.id, 'customer.restore');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.newValue).toMatchObject({ isActive: true });

      const listedAfter = await run(() => customers.list({ page: 1, pageSize: 100, deleted: true } as never, owner));
      expect((listedAfter.data as Array<{ id: string }>).map((r) => r.id)).not.toContain(c.id);
    });

    it('falls back to isActive=false without a delete audit row', async () => {
      const c = await newCustomer(companyId, { isActive: true });
      await softDelete(c.id);
      expect((await run(() => customers.restore(c.id, owner))).isActive).toBe(false);
    });

    it('live customer with the same code → CUSTOMER_CODE_CONFLICT_ON_RESTORE, nothing changed, audited', async () => {
      const c = await newCustomer();
      await run(() => customers.remove(c.id, owner));
      await run((tx) => tx.customer.create({ data: { companyId, code: c.code, name: 'reuser' } }));
      expect(await errOf(run(() => customers.restore(c.id, owner)))).toMatchObject({ code: 'CUSTOMER_CODE_CONFLICT_ON_RESTORE', details: { code: c.code } });
      expect((await run((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).not.toBeNull();
      const audit = await auditRows(c.id, 'customer.restore_rejected');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.newValue).toMatchObject({ reason: 'CUSTOMER_CODE_CONFLICT_ON_RESTORE' });
    });

    it('not deleted / other tenant → 404 (audited as rejection)', async () => {
      const live = await newCustomer();
      expect(await codeOf(run(() => customers.restore(live.id, owner)))).toBe('CUSTOMER_NOT_FOUND');
      const c = await newCustomer();
      await run(() => customers.remove(c.id, owner));
      expect(await codeOf(run(() => customers.restore(c.id, ownerB), companyB))).toBe('CUSTOMER_NOT_FOUND');
      expect((await run((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).not.toBeNull();
      expect(await auditRows(live.id, 'customer.restore_rejected')).toHaveLength(1);
      expect(await auditRows(c.id, 'customer.restore_rejected', companyB)).toHaveLength(1);
    });
  });
});
