import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../../customers/customers.service';
import {
  AllocationExceedsInvoiceException,
  AllocationExceedsPaymentException,
  InvoiceNotFoundException,
  PaymentAlreadyReversedException,
  PaymentExportedTo1cException,
  PaymentInClosedCashSessionException,
  PaymentNotFoundException,
} from '../finance-exceptions';
import { CashSessionsService } from '../cash-sessions/cash-sessions.service';
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
      payments.list({ page: 1, pageSize: 100, collectedBy: user.id, from: today, to: today }, user),
    );
    expect(todayList.data.map((p) => p.id)).toContain(payment.id);

    const futureList = await tenantPrisma.run(companyId, () =>
      payments.list({ page: 1, pageSize: 100, collectedBy: user.id, from: tomorrow, to: tomorrow }, user),
    );
    expect(futureList.data.map((p) => p.id)).not.toContain(payment.id);

    const unbounded = await tenantPrisma.run(companyId, () =>
      payments.list({ page: 1, pageSize: 100, customerId }, user),
    );
    expect(unbounded.data.map((p) => p.id)).toContain(payment.id);
  });

  it('SEC-023 (15.3): a SALES_AGENT only sees payments they collected via list()/getById()', async () => {
    const [agent1, agent2] = await Promise.all(
      ['+998900000015', '+998900000016'].map(async (phone, i) => {
        const dbUser = await systemPrisma.user.create({
          data: { companyId, firstName: 'Scoped', lastName: `Agent${i + 1}`, phone },
        });
        return {
          id: dbUser.id,
          companyId,
          firstName: 'Scoped',
          lastName: `Agent${i + 1}`,
          roles: ['SALES_AGENT'],
          permissions: ['payments.create', 'payments.read'],
        } satisfies AuthenticatedUser;
      }),
    );

    const { customerId } = await createCustomerWithInvoices([{ total: '20000', ageDays: 1 }]);
    const own = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 5000, method: 'CASH' }, agent1),
    );
    const other = await tenantPrisma.run(companyId, () =>
      payments.create({ customerId, amount: 5000, method: 'CASH' }, agent2),
    );

    const agent1List = await tenantPrisma.run(companyId, () => payments.list({ page: 1, pageSize: 100 }, agent1));
    const ids = agent1List.data.map((p) => p.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(other.id);

    // Passing another collector's id must not override the server-enforced scope.
    const spoofed = await tenantPrisma.run(companyId, () =>
      payments.list({ page: 1, pageSize: 100, collectedBy: agent2.id }, agent1),
    );
    expect(spoofed.data.map((p) => p.id)).not.toContain(other.id);

    await expect(tenantPrisma.run(companyId, () => payments.getById(other.id, agent1))).rejects.toBeInstanceOf(
      PaymentNotFoundException,
    );
    expect((await tenantPrisma.run(companyId, () => payments.getById(own.id, agent1))).id).toBe(own.id);

    // CASHIER (and every other non-agent role) stays unrestricted.
    const cashierList = await tenantPrisma.run(companyId, () => payments.list({ page: 1, pageSize: 100 }, user));
    expect(cashierList.data.map((p) => p.id)).toEqual(expect.arrayContaining([own.id, other.id]));
  });
  /**
   * Ledger truth, independent of service code (F2.1): Σ non-cancelled invoices
   * − Σ POSTED payments (allocated part + advance). REVERSED never counts.
   */
  async function ledgerBalance(customerId: string) {
    const rows = await tenantPrisma.run(companyId, (tx) =>
      tx.$queryRaw<{ balance: string }[]>`
        SELECT (
          COALESCE((SELECT SUM(total) FROM "Invoice" WHERE "customerId" = ${customerId}::uuid AND status <> 'CANCELLED'), 0)
          - COALESCE((SELECT SUM(amount) FROM "Payment" WHERE "customerId" = ${customerId}::uuid AND status = 'POSTED'), 0)
        )::text AS balance`,
    );
    return rows[0]!.balance;
  }

  async function cachedBalance(customerId: string) {
    const c = await tenantPrisma.run(companyId, (tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } }));
    return c.cachedBalance;
  }

  async function customerLedger(customerId: string) {
    return tenantPrisma.run(companyId, () => customers.getCustomerBalance(customerId, user));
  }

  describe('advance / avans (F2.1)', () => {
    it('over-payment: remainder is the payment advance and the balance goes negative (credit)', async () => {
      const { customerId } = await createCustomerWithInvoices([{ total: '10000', ageDays: 1 }]);
      const payment = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 15000, method: 'CASH' }, user));

      expect(payment.advance).toBe('5000');
      const ledger = await customerLedger(customerId);
      expect(ledger.advance).toBe('5000');
      expect(ledger.balance.toString()).toBe('-5000');
      expect((await cachedBalance(customerId)).toString()).toBe('-5000');
      expect(Number(await ledgerBalance(customerId))).toBe(-5000);

      const detail = await tenantPrisma.run(companyId, () => customers.getById(customerId, user));
      expect(detail.advance).toBe('5000');
      expect((await tenantPrisma.run(companyId, () => payments.getById(payment.id, user))).advance).toBe('5000');
    });

    it('partial allocation: under-payment leaves no advance; advance is never auto-applied to a later invoice', async () => {
      const { customerId, invoiceIds } = await createCustomerWithInvoices([{ total: '10000', ageDays: 2 }]);
      const under = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 4000, method: 'CASH' }, user));
      expect(under.advance).toBe('0');
      expect((await customerLedger(customerId)).balance.toString()).toBe('6000');

      const over = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 9000, method: 'CASH' }, user));
      expect(over.advance).toBe('3000');

      // A new invoice after the advance exists: it stays OPEN, advance untouched.
      const later = await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.create({ data: { companyId, number: `PAY-TEST-INV-${Date.now()}-${invoiceSeq++}`, customerId, total: '7000', status: 'OPEN' } }),
      );
      const fresh = await tenantPrisma.run(companyId, (tx) =>
        tx.invoice.findUniqueOrThrow({ where: { id: later.id }, include: { allocations: true } }),
      );
      expect(fresh.status).toBe('OPEN');
      expect(fresh.allocations).toHaveLength(0);
      expect(invoiceIds).toHaveLength(1);
      const ledger = await customerLedger(customerId);
      expect(ledger.advance).toBe('3000');
      expect(ledger.balance.toString()).toBe('4000'); // 17000 − 13000
      expect(Number(await ledgerBalance(customerId))).toBe(4000);
    });

    it('a REVERSED payment is never an advance', async () => {
      const { customerId } = await createCustomerWithInvoices([{ total: '10000', ageDays: 1 }]);
      const payment = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 25000, method: 'TRANSFER' }, user));
      expect(payment.advance).toBe('15000');

      const reversed = await tenantPrisma.run(companyId, () => payments.reverse(payment.id, 'wrong amount', user));
      expect(reversed.advance).toBe('0');
      const ledger = await customerLedger(customerId);
      expect(ledger.advance).toBe('0');
      expect(ledger.balance.toString()).toBe('10000');
      expect((await cachedBalance(customerId)).toString()).toBe('10000');
    });

    it('manual allocation reduces the advance by exactly the allocated amount', async () => {
      const { customerId, invoiceIds } = await createCustomerWithInvoices([
        { total: '10000', ageDays: 5 },
        { total: '20000', ageDays: 1 },
      ]);
      const payment = await tenantPrisma.run(companyId, () =>
        payments.create({ customerId, amount: 25000, method: 'CARD', allocations: [{ invoiceId: invoiceIds[1]!, amount: 20000 }] }, user),
      );
      expect(payment.advance).toBe('5000');
      const oldest = await tenantPrisma.run(companyId, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoiceIds[0]! } }));
      expect(oldest.status).toBe('OPEN'); // manual mode: remainder is NOT FIFO-applied
      const ledger = await customerLedger(customerId);
      expect(ledger.advance).toBe('5000');
      expect(ledger.balance.toString()).toBe('5000'); // 30000 − 20000 − 5000
      expect((await cachedBalance(customerId)).toString()).toBe('5000');
    });

    it('race: parallel FIFO, manual and over-payments on one customer keep advance, cache and ledger consistent', async () => {
      for (let round = 0; round < 3; round++) {
        const { customerId, invoiceIds } = await createCustomerWithInvoices([
          { total: '100000', ageDays: 9 },
          { total: '100000', ageDays: 3 },
        ]);
        const settled = await Promise.allSettled([
          tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 150000, method: 'TRANSFER' }, user)),
          tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 120000, method: 'CASH' }, user)),
          tenantPrisma.run(companyId, () =>
            payments.create({ customerId, amount: 30000, method: 'CARD', allocations: [{ invoiceId: invoiceIds[1]!, amount: 10000 }] }, user),
          ),
        ]);
        // The two FIFO payments must succeed; the manual one may legitimately
        // lose to them (invoice already PAID / outstanding too small) and roll back whole.
        expect(settled[0]!.status).toBe('fulfilled');
        expect(settled[1]!.status).toBe('fulfilled');
        if (settled[2]!.status === 'rejected') {
          expect(settled[2]!.reason).toSatisfy(
            (e: unknown) => e instanceof InvoiceNotFoundException || e instanceof AllocationExceedsInvoiceException,
          );
        }
        const results = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
        const paid = results.reduce((s, p) => s + Number(p.amount), 0);

        for (const invoiceId of invoiceIds) {
          const inv = await tenantPrisma.run(companyId, (tx) =>
            tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { allocations: true } }),
          );
          expect(inv.allocations.reduce((s, a) => s + Number(a.amount), 0)).toBeLessThanOrEqual(Number(inv.total));
        }
        const sumAdvance = results.reduce((s, p) => s + Number(p.advance), 0);
        const ledger = await customerLedger(customerId);
        // FIFO payments alone (270000) exceed the 200000 invoiced, so both
        // invoices end fully paid and everything else is advance.
        expect(sumAdvance).toBe(paid - 200000);
        expect(Number(ledger.advance)).toBe(paid - 200000);
        expect(Number(ledger.balance)).toBe(200000 - paid);
        expect(Number((await cachedBalance(customerId)).toString())).toBe(200000 - paid);
        expect(Number(await ledgerBalance(customerId))).toBe(200000 - paid);
      }
    });
  });

  describe('reverse() (F2.1)', () => {
    async function newCollector(label: string): Promise<AuthenticatedUser> {
      const u = await systemPrisma.user.create({
        data: { companyId, firstName: label, lastName: 'Rev', phone: `+99891${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
      });
      return { id: u.id, companyId, firstName: label, lastName: 'Rev', roles: ['CASHIER'], permissions: ['payments.create', 'payments.reverse'] };
    }

    it('keeps the original payment/allocation rows, reopens invoices, recomputes balance from the ledger, audits reason', async () => {
      const { customerId, invoiceIds } = await createCustomerWithInvoices([
        { total: '500000', ageDays: 30 },
        { total: '500000', ageDays: 20 },
        { total: '500000', ageDays: 10 },
      ]);
      const payment = await tenantPrisma.run(companyId, () =>
        payments.create({ customerId, amount: 700000, method: 'TRANSFER' }, user),
      );
      const allocBefore = await tenantPrisma.run(companyId, (tx) =>
        tx.paymentAllocation.findMany({ where: { paymentId: payment.id }, orderBy: { id: 'asc' } }),
      );
      expect(allocBefore).toHaveLength(2);

      const reversed = await tenantPrisma.run(companyId, () => payments.reverse(payment.id, '  wrong customer  ', user));
      expect(reversed.status).toBe('REVERSED');
      expect(reversed.amount.toString()).toBe('700000');
      expect(reversed.number).toBe(payment.number);

      const allocAfter = await tenantPrisma.run(companyId, (tx) =>
        tx.paymentAllocation.findMany({ where: { paymentId: payment.id }, orderBy: { id: 'asc' } }),
      );
      expect(allocAfter).toEqual(allocBefore);

      const reversal = await tenantPrisma.run(companyId, (tx) =>
        tx.paymentReversal.findUniqueOrThrow({ where: { reversesPaymentId: payment.id } }),
      );
      expect(reversal.reason).toBe('wrong customer');
      expect(reversal.actorId).toBe(user.id);

      const invoices = await tenantPrisma.run(companyId, (tx) => tx.invoice.findMany({ where: { id: { in: invoiceIds } } }));
      expect(invoices.every((i) => i.status === 'OPEN')).toBe(true);

      expect(await ledgerBalance(customerId)).toBe('1500000.00');
      expect((await cachedBalance(customerId)).toString()).toBe('1500000');

      const audit = await tenantPrisma.run(companyId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { action: 'payment.reverse', entityId: payment.id } }),
      );
      expect(audit.newValue).toMatchObject({ status: 'REVERSED', reason: 'wrong customer' });

      // A new payment now FIFO-allocates to the reopened oldest invoice again.
      const again = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 500000, method: 'TRANSFER' }, user));
      expect(again.allocations.map((a) => a.invoiceId)).toEqual([invoiceIds[0]]);
    });

    it('a second reverse is rejected; parallel reversals of one payment yield exactly one PaymentReversal', async () => {
      const { customerId } = await createCustomerWithInvoices([{ total: '100000', ageDays: 5 }]);
      const p1 = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 100000, method: 'TRANSFER' }, user));
      await tenantPrisma.run(companyId, () => payments.reverse(p1.id, 'duplicate entry', user));
      await expect(tenantPrisma.run(companyId, () => payments.reverse(p1.id, 'again', user))).rejects.toBeInstanceOf(
        PaymentAlreadyReversedException,
      );

      const p2 = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 100000, method: 'TRANSFER' }, user));
      const results = await Promise.allSettled(
        [1, 2, 3].map(() => tenantPrisma.run(companyId, () => payments.reverse(p2.id, 'race reverse', user))),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PaymentAlreadyReversedException);
      }
      const count = await tenantPrisma.run(companyId, (tx) => tx.paymentReversal.count({ where: { reversesPaymentId: p2.id } }));
      expect(count).toBe(1);
      expect(Number((await cachedBalance(customerId)).toString())).toBe(Number(await ledgerBalance(customerId)));
    });

    it('race: reversal vs a parallel FIFO allocation on the same customer stays consistent (no over-allocation, cache = ledger)', async () => {
      for (let round = 0; round < 3; round++) {
        const { customerId, invoiceIds } = await createCustomerWithInvoices([
          { total: '300000', ageDays: 15 },
          { total: '300000', ageDays: 10 },
        ]);
        const p1 = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 300000, method: 'TRANSFER' }, user));

        await Promise.all([
          tenantPrisma.run(companyId, () => payments.reverse(p1.id, 'race with allocation', user)),
          tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 400000, method: 'TRANSFER' }, user)),
        ]);

        for (const invoiceId of invoiceIds) {
          const inv = await tenantPrisma.run(companyId, (tx) =>
            tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { allocations: { include: { payment: true } } } }),
          );
          const valid = inv.allocations.filter((a) => a.payment.status === 'POSTED').reduce((s, a) => s + Number(a.amount), 0);
          expect(valid).toBeLessThanOrEqual(Number(inv.total));
          const expected = valid === 0 ? 'OPEN' : valid >= Number(inv.total) ? 'PAID' : 'PARTIALLY_PAID';
          expect(inv.status).toBe(expected);
        }
        expect(Number((await cachedBalance(customerId)).toString())).toBe(Number(await ledgerBalance(customerId)));
        // Both orders are valid: total valid allocation is the 400 000 payment, capped by open debt.
        expect(Number(await ledgerBalance(customerId))).toBeGreaterThanOrEqual(200000);
      }
    });

    it('CASH payment inside a closed cash session cannot be reversed; inside an open one it can and leaves the shift total', async () => {
      const cashier = await newCollector('Closed');
      const cashSessions = new CashSessionsService(tenantPrisma, auditLog);
      const { customerId } = await createCustomerWithInvoices([{ total: '90000', ageDays: 3 }]);

      await tenantPrisma.run(companyId, () => cashSessions.open({ openAmount: 0 }, cashier));
      const inClosed = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 10000, method: 'CASH' }, cashier));
      const session = await tenantPrisma.run(companyId, () => cashSessions.current(cashier));
      await tenantPrisma.run(companyId, () => cashSessions.close(session.id, { closeAmount: 10000 }, cashier));

      await expect(tenantPrisma.run(companyId, () => payments.reverse(inClosed.id, 'closed shift', cashier))).rejects.toBeInstanceOf(
        PaymentInClosedCashSessionException,
      );
      const still = await tenantPrisma.run(companyId, (tx) => tx.payment.findUniqueOrThrow({ where: { id: inClosed.id } }));
      expect(still.status).toBe('POSTED');

      await tenantPrisma.run(companyId, () => cashSessions.open({ openAmount: 0 }, cashier));
      const inOpen = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 20000, method: 'CASH' }, cashier));
      await tenantPrisma.run(companyId, () => payments.reverse(inOpen.id, 'cash returned', cashier));
      const current = await tenantPrisma.run(companyId, () => cashSessions.current(cashier));
      expect(current.totalCollected.toString()).toBe('0');
    });

    it('payment within a non-FAILED 1C export period cannot be reversed; a FAILED job does not block', async () => {
      const { customerId } = await createCustomerWithInvoices([{ total: '50000', ageDays: 2 }]);
      const p = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 50000, method: 'TRANSFER' }, user));
      const q = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 1000, method: 'TRANSFER' }, user));

      await tenantPrisma.run(companyId, (tx) =>
        tx.exportJob.createMany({
          data: [
            { companyId, type: '1c', format: 'XML', periodFrom: p.createdAt, periodTo: p.createdAt, status: 'DONE' },
            { companyId, type: '1c', format: 'XML', periodFrom: q.createdAt, periodTo: q.createdAt, status: 'FAILED' },
          ],
        }),
      );

      await expect(tenantPrisma.run(companyId, () => payments.reverse(p.id, 'after export', user))).rejects.toBeInstanceOf(
        PaymentExportedTo1cException,
      );
      const reversedQ = await tenantPrisma.run(companyId, () => payments.reverse(q.id, 'export failed', user));
      expect(reversedQ.status).toBe('REVERSED');
    });
  });
});
