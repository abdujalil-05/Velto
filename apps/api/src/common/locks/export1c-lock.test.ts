import { afterAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditLogService } from '../audit/audit-log.service';
import { DocumentNumberingService } from '../document-numbering/document-numbering.service';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { CustomersService } from '../../modules/customers/customers.service';
import { PaymentExportedTo1cException } from '../../modules/finance/finance-exceptions';
import { PaymentsService } from '../../modules/finance/payments/payments.service';
import { Export1cService } from '../../modules/integrations/export-1c/export-1c.service';
import { StockService } from '../../modules/stock/stock.service';
import { lockExport1cExclusive } from './export1c-lock';

/**
 * ADR-025: 1C export create() (exclusive) vs payments.reverse() (shared) on
 * the per-company advisory lock. Each round uses a fresh company so earlier
 * rounds' export periods (which cover "today") never block later reversals.
 */
describe('export1c advisory lock (ADR-025, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService());
  const fakeQueue = { add: async () => ({}) } as never;
  const export1c = new Export1cService(tenantPrisma, fakeQueue, auditLog);
  const stock = new StockService(tenantPrisma, auditLog);
  const DAY = 24 * 3600 * 1000;
  const period = () => ({
    from: new Date(Date.now() - DAY).toISOString().slice(0, 10),
    to: new Date(Date.now() + DAY).toISOString().slice(0, 10),
    format: 'EXCEL' as const,
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function newCompany(): Promise<AuthenticatedUser> {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-x1c-lock-${suffix}`, name: 'X1C Lock Tenant' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'X1C Lock Co' } });
    const u = await systemPrisma.user.create({
      data: { companyId: company.id, firstName: 'Lock', lastName: 'Test', phone: `+99893${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
    });
    return {
      id: u.id,
      companyId: company.id,
      firstName: 'Lock',
      lastName: 'Test',
      roles: ['OWNER'],
      permissions: ['payments.create', 'payments.reverse', 'integrations.export'],
    };
  }

  async function newPostedPayment(user: AuthenticatedUser): Promise<string> {
    const { customer } = await tenantPrisma.run(user.companyId, () =>
      customers.create({ code: `X1C-${Date.now()}-${Math.random()}`, name: 'X1C Customer' }, user),
    );
    const p = await tenantPrisma.run(user.companyId, () =>
      payments.create({ customerId: (customer as { id: string }).id, amount: 10000, method: 'TRANSFER' }, user),
    );
    return p.id;
  }

  /** Runs fn in a tenant tx and keeps the tx (and its locks) open until release(). */
  function runHeld<T>(companyId: string, fn: () => Promise<T>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markDone!: (v: T) => void;
    const done = new Promise<T>((r) => (markDone = r));
    const committed = tenantPrisma.run(
      companyId,
      async () => {
        const v = await fn();
        markDone(v);
        await gate;
        return v;
      },
      { timeout: 20_000 },
    );
    return { done: Promise.race([done, committed]), committed, release };
  }

  /** Resolves once some backend is blocked on this company's export1c advisory lock. */
  async function waitForAdvisoryWaiter(companyId: string) {
    for (let i = 0; i < 200; i++) {
      const [{ n }] = await systemPrisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
          AND classid = hashtext('velto.export1c')::oid AND objid = hashtext(${companyId})::oid`;
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no waiter on export1c advisory lock');
  }

  const within = <T>(p: Promise<T>, ms = 5_000) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`blocked > ${ms}ms`)), ms))]);

  async function postedInExportPeriod(companyId: string, paymentId: string) {
    return tenantPrisma.run(companyId, async (tx) => ({
      status: (await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
      jobs: await tx.exportJob.count({ where: { type: '1c' } }),
    }));
  }

  it('export create() first: a concurrent reverse() waits, then is rejected (N=4)', async () => {
    for (let round = 0; round < 4; round++) {
      const user = await newCompany();
      const paymentId = await newPostedPayment(user);

      const exp = runHeld(user.companyId, () => export1c.create(period(), user));
      await exp.done;
      const rev = tenantPrisma.run(user.companyId, () => payments.reverse(paymentId, 'race export first', user));
      const revSettled = rev.then(
        () => 'ok',
        (e: unknown) => e,
      );
      await waitForAdvisoryWaiter(user.companyId);
      exp.release();
      await exp.committed;

      expect(await revSettled).toBeInstanceOf(PaymentExportedTo1cException);
      expect(await postedInExportPeriod(user.companyId, paymentId)).toEqual({ status: 'POSTED', jobs: 1 });
    }
  });

  it('reverse() first: a concurrent export create() waits, so the export never sees the payment as POSTED (N=4)', async () => {
    for (let round = 0; round < 4; round++) {
      const user = await newCompany();
      const paymentId = await newPostedPayment(user);

      const rev = runHeld(user.companyId, () => payments.reverse(paymentId, 'race reverse first', user));
      await rev.done;
      const exp = tenantPrisma.run(user.companyId, () => export1c.create(period(), user));
      await waitForAdvisoryWaiter(user.companyId);
      rev.release();
      await Promise.all([rev.committed, exp]);

      expect(await postedInExportPeriod(user.companyId, paymentId)).toEqual({ status: 'REVERSED', jobs: 1 });
    }
  });

  it('free-running export create() vs reverse(): no deadlock, never a reversed payment inside an exported period unseen (N=4)', async () => {
    for (let round = 0; round < 4; round++) {
      const user = await newCompany();
      const paymentId = await newPostedPayment(user);
      const [exp, rev] = await Promise.allSettled([
        tenantPrisma.run(user.companyId, () => export1c.create(period(), user)),
        tenantPrisma.run(user.companyId, () => payments.reverse(paymentId, 'free race', user)),
      ]);
      expect(exp.status).toBe('fulfilled');
      const state = await postedInExportPeriod(user.companyId, paymentId);
      if (rev.status === 'rejected') {
        expect(rev.reason).toBeInstanceOf(PaymentExportedTo1cException);
        expect(state).toEqual({ status: 'POSTED', jobs: 1 });
      } else {
        expect(state).toEqual({ status: 'REVERSED', jobs: 1 });
      }
    }
  });

  it('two reversals take the lock SHARED and do not wait for each other', async () => {
    const user = await newCompany();
    const [p1, p2] = [await newPostedPayment(user), await newPostedPayment(user)];

    const first = runHeld(user.companyId, () => payments.reverse(p1, 'shared one', user));
    await first.done;
    // first still holds its shared lock (tx open); second must complete regardless.
    const second = await within(tenantPrisma.run(user.companyId, () => payments.reverse(p2, 'shared two', user)));
    expect(second.status).toBe('REVERSED');
    first.release();
    await first.committed;
  });

  it('stock reverseMovement() takes no export1c lock (stock is not exported to 1C)', async () => {
    const user = await newCompany();
    const movementId = await tenantPrisma.run(user.companyId, async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { companyId: user.companyId, name: 'X1C WH' } });
      const product = await tx.product.create({
        data: { companyId: user.companyId, sku: `X1C-${Date.now()}`, name: 'X1C Product', baseUnit: 'dona', vatRate: 12 },
      });
      await stock.receive({ productId: product.id, warehouseId: warehouse.id, qty: 5 }, user);
      const m = await tx.stockMovement.findFirstOrThrow({ where: { productId: product.id }, select: { id: true } });
      return m.id;
    });

    const holder = runHeld(user.companyId, () => lockExport1cExclusive());
    await holder.done;
    await within(tenantPrisma.run(user.companyId, () => stock.reverseMovement(movementId, 'stock not exported', user)));
    holder.release();
    await holder.committed;
  });
});
