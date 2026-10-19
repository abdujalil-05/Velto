import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../../customers/customers.service';
import { CashSessionsService } from '../cash-sessions/cash-sessions.service';
import {
  PaymentExportedTo1cException,
  PaymentHandoverNoOpenCashSessionException,
  PaymentHandoverRejectReasonRequiredException,
  PaymentHandoverSelfResolveException,
  PaymentInClosedCashSessionException,
  PaymentNotPendingHandoverException,
  PaymentNotReversibleException,
  PaymentPendingHandoverAllocationException,
} from '../finance-exceptions';
import { paymentPostedWithin } from '../ledger-filters';
import { PaymentsService } from './payments.service';

/** ADR-029 / TZ §6.5, F-01: agent cash PENDING_HANDOVER -> cashier accept (POSTED + FIFO) / reject. */
describe('Payment handover (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let seq = 0;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService());
  const cashSessions = new CashSessionsService(tenantPrisma, auditLog);
  const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);

  async function newUser(roles: string[]): Promise<AuthenticatedUser> {
    const u = await systemPrisma.user.create({
      data: { companyId, firstName: roles.join('-'), lastName: `U${++seq}`, phone: `+99897${Math.floor(1_000_000 + Math.random() * 8_999_999)}` },
    });
    return { id: u.id, companyId, firstName: u.firstName, lastName: u.lastName, roles, permissions: [] };
  }

  async function customerWithInvoices(totals: { total: string; ageDays: number }[]) {
    return tenantPrisma.run(companyId, async (tx) => {
      const c = await tx.customer.create({ data: { companyId, code: `HO-${Date.now()}-${++seq}`, name: 'Handover Customer' } });
      const invoiceIds: string[] = [];
      for (const { total, ageDays } of totals) {
        const inv = await tx.invoice.create({
          data: { companyId, number: `HO-INV-${Date.now()}-${++seq}`, customerId: c.id, total, status: 'OPEN', createdAt: new Date(Date.now() - ageDays * 86_400_000) },
        });
        invoiceIds.push(inv.id);
      }
      return { customerId: c.id, invoiceIds };
    });
  }

  const balance = (customerId: string) => tenantPrisma.run(companyId, (tx) => customers.getBalance(tx, customerId));
  const cached = (customerId: string) =>
    tenantPrisma.run(companyId, (tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } })).then((c) => c.cachedBalance.toString());
  const tick = () => new Promise((r) => setTimeout(r, 5));

  let agent: AuthenticatedUser;
  let cashier: AuthenticatedUser;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-handover-${Date.now()}`, name: 'Handover Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Handover Co' } })).id;
    agent = await newUser(['SALES_AGENT']);
    cashier = await newUser(['CASHIER']);
    await run(() => cashSessions.open({ openAmount: 0 }, cashier));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('agent cash is PENDING_HANDOVER: no allocation, balance/cachedBalance unchanged, shown as in transit; manual allocations refused', async () => {
    const { customerId, invoiceIds } = await customerWithInvoices([{ total: '100000', ageDays: 5 }]);
    const before = await balance(customerId);

    const p = await run(() => payments.create({ customerId, amount: 40000, method: 'CASH' }, agent));
    expect(p.status).toBe('PENDING_HANDOVER');
    expect(p.allocations).toHaveLength(0);
    expect(p.advance).toBe('0');
    expect((await balance(customerId)).toString()).toBe(before.toString());
    expect(await cached(customerId)).toBe('0');

    expect(await run(() => payments.inTransitSummary(customerId, cashier))).toEqual({ customerId, amount: '40000', count: 1 });
    const pending = await run(() => payments.list({ page: 1, pageSize: 50, customerId, status: 'PENDING_HANDOVER' }, cashier));
    expect(pending.data.map((x) => x.id)).toEqual([p.id]);

    await expect(
      run(() => payments.create({ customerId, amount: 1000, method: 'CASH', allocations: [{ invoiceId: invoiceIds[0]!, amount: 1000 }] }, agent)),
    ).rejects.toBeInstanceOf(PaymentPendingHandoverAllocationException);
    // Agent non-cash and cashier cash keep posting immediately.
    expect((await run(() => payments.create({ customerId, amount: 1000, method: 'TRANSFER' }, agent))).status).toBe('POSTED');
    expect((await run(() => payments.create({ customerId, amount: 1000, method: 'CASH' }, cashier))).status).toBe('POSTED');
  });

  it('accept: 1 500 000 over 3 invoices -> POSTED, FIFO oldest first, Σ ≤ payment, balance + cachedBalance, shift total, audit', async () => {
    const { customerId, invoiceIds } = await customerWithInvoices([
      { total: '600000', ageDays: 20 },
      { total: '400000', ageDays: 30 }, // oldest
      { total: '800000', ageDays: 10 },
    ]);
    const p = await run(() => payments.create({ customerId, amount: 1500000, method: 'CASH' }, agent));
    expect((await balance(customerId)).toString()).toBe('1800000');
    const shiftBefore = (await run(() => cashSessions.current(cashier))).totalCollected;

    const accepted = await run(() => payments.acceptHandover(p.id, cashier));
    expect(accepted.status).toBe('POSTED');
    expect(accepted.handoverActorId).toBe(cashier.id);
    expect(accepted.handoverAt).toBeInstanceOf(Date);
    const session = await run(() => cashSessions.current(cashier));
    expect(accepted.handoverCashSessionId).toBe(session.id);

    const byInvoice = new Map(accepted.allocations.map((a) => [a.invoiceId, a.amount.toString()]));
    expect(byInvoice.get(invoiceIds[1]!)).toBe('400000');
    expect(byInvoice.get(invoiceIds[0]!)).toBe('600000');
    expect(byInvoice.get(invoiceIds[2]!)).toBe('500000');
    expect(accepted.allocations.reduce((s, a) => s + Number(a.amount), 0)).toBe(1500000);
    expect(accepted.advance).toBe('0');
    expect((await balance(customerId)).toString()).toBe('300000');
    expect(await cached(customerId)).toBe('300000');
    expect(session.totalCollected.minus(shiftBefore).toString()).toBe('1500000');

    const audits = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { entityId: p.id }, select: { action: true } }));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['payment.create', 'payment.handover.accept', 'payment.allocate']));

    await expect(run(() => payments.acceptHandover(p.id, cashier))).rejects.toBeInstanceOf(PaymentNotPendingHandoverException);
  });

  it('reject: reason mandatory, -> REJECTED with no ledger effect, cannot be accepted or reversed afterwards', async () => {
    const { customerId } = await customerWithInvoices([{ total: '50000', ageDays: 3 }]);
    const p = await run(() => payments.create({ customerId, amount: 20000, method: 'CASH' }, agent));

    await expect(run(() => payments.rejectHandover(p.id, '  ', cashier))).rejects.toBeInstanceOf(PaymentHandoverRejectReasonRequiredException);
    const rejected = await run(() => payments.rejectHandover(p.id, 'counterfeit notes', cashier));
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.handoverRejectReason).toBe('counterfeit notes');
    expect(rejected.allocations).toHaveLength(0);
    expect((await balance(customerId)).toString()).toBe('50000');

    await expect(run(() => payments.acceptHandover(p.id, cashier))).rejects.toBeInstanceOf(PaymentNotPendingHandoverException);
    await expect(run(() => payments.reverse(p.id, 'try reverse', cashier))).rejects.toBeInstanceOf(PaymentNotReversibleException);
    const audit = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findFirst({ where: { entityId: p.id, action: 'payment.handover.reject' } }));
    expect(audit).not.toBeNull();
  });

  it('reverse of a PENDING_HANDOVER payment is refused', async () => {
    const { customerId } = await customerWithInvoices([{ total: '10000', ageDays: 1 }]);
    const p = await run(() => payments.create({ customerId, amount: 5000, method: 'CASH' }, agent));
    await expect(run(() => payments.reverse(p.id, 'not yet', cashier))).rejects.toBeInstanceOf(PaymentNotReversibleException);
  });

  it('the collector can never accept/reject their own cash, even holding a cashier role and an open shift', async () => {
    const dual = await newUser(['SALES_AGENT', 'CASHIER']);
    await run(() => cashSessions.open({ openAmount: 0 }, dual));
    const { customerId } = await customerWithInvoices([{ total: '10000', ageDays: 1 }]);
    const p = await run(() => payments.create({ customerId, amount: 5000, method: 'CASH' }, dual));
    expect(p.status).toBe('PENDING_HANDOVER');
    await expect(run(() => payments.acceptHandover(p.id, dual))).rejects.toBeInstanceOf(PaymentHandoverSelfResolveException);
    await expect(run(() => payments.rejectHandover(p.id, 'my own', dual))).rejects.toBeInstanceOf(PaymentHandoverSelfResolveException);
  });

  it('accept without an own open cash session is refused and leaves the payment pending', async () => {
    const noShift = await newUser(['CASHIER']);
    const { customerId } = await customerWithInvoices([{ total: '10000', ageDays: 1 }]);
    const p = await run(() => payments.create({ customerId, amount: 5000, method: 'CASH' }, agent));
    await expect(run(() => payments.acceptHandover(p.id, noShift))).rejects.toBeInstanceOf(PaymentHandoverNoOpenCashSessionException);
    const row = await tenantPrisma.run(companyId, (tx) => tx.payment.findUniqueOrThrow({ where: { id: p.id } }));
    expect(row.status).toBe('PENDING_HANDOVER');
  });

  it('race: two cashiers accept the same payment concurrently — exactly one wins, allocated once', async () => {
    const cashier2 = await newUser(['CASHIER']);
    await run(() => cashSessions.open({ openAmount: 0 }, cashier2));
    const { customerId } = await customerWithInvoices([{ total: '70000', ageDays: 2 }]);
    const p = await run(() => payments.create({ customerId, amount: 50000, method: 'CASH' }, agent));

    const settled = await Promise.allSettled([
      run(() => payments.acceptHandover(p.id, cashier)),
      run(() => payments.acceptHandover(p.id, cashier2)),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(PaymentNotPendingHandoverException);

    const allocs = await tenantPrisma.run(companyId, (tx) => tx.paymentAllocation.findMany({ where: { paymentId: p.id } }));
    expect(allocs.reduce((s, a) => s + Number(a.amount), 0)).toBe(50000);
    expect((await balance(customerId)).toString()).toBe('20000');
    expect(await cached(customerId)).toBe('20000');
  });

  it('period rules use coalesce(handoverAt, createdAt): 1C export guard, closed-shift guard, shift summary', async () => {
    const shiftCashier = await newUser(['CASHIER']);
    await run(() => cashSessions.open({ openAmount: 0 }, shiftCashier));
    const { customerId } = await customerWithInvoices([{ total: '900000', ageDays: 4 }]);
    const collect = async (amount: number) => {
      const p = await run(() => payments.create({ customerId, amount, method: 'CASH' }, agent));
      await tick();
      return run(() => payments.acceptHandover(p.id, shiftCashier));
    };
    const p1 = await collect(10000);
    const p2 = await collect(20000);
    const p3 = await collect(30000);

    // An export of the collection instant does not contain p1 (posted later) -> reversible.
    await tenantPrisma.run(companyId, (tx) =>
      tx.exportJob.createMany({
        data: [
          { companyId, type: '1c', format: 'XML', periodFrom: p1.createdAt, periodTo: p1.createdAt, status: 'DONE' },
          { companyId, type: '1c', format: 'XML', periodFrom: p2.handoverAt!, periodTo: p2.handoverAt!, status: 'DONE' },
        ],
      }),
    );
    const inP1Collection = await tenantPrisma.run(companyId, (tx) =>
      tx.payment.findMany({ where: { id: { in: [p1.id, p2.id] }, ...paymentPostedWithin({ gte: p1.createdAt, lte: p1.createdAt }) } }),
    );
    expect(inP1Collection).toHaveLength(0);
    const inP2Posting = await tenantPrisma.run(companyId, (tx) =>
      tx.payment.findMany({ where: { id: { in: [p1.id, p2.id] }, ...paymentPostedWithin({ gte: p2.handoverAt!, lte: p2.handoverAt! }) } }),
    );
    expect(inP2Posting.map((x) => x.id)).toEqual([p2.id]);

    expect((await run(() => payments.reverse(p1.id, 'cash returned', shiftCashier))).status).toBe('REVERSED');
    await expect(run(() => payments.reverse(p2.id, 'after export', shiftCashier))).rejects.toBeInstanceOf(PaymentExportedTo1cException);

    // The accepted payment belongs to the acceptor's shift (not the collector's) — closing it locks reversal.
    const session = await run(() => cashSessions.current(shiftCashier));
    expect(session.totalCollected.toString()).toBe('50000'); // p2 + p3; p1 reversed
    await run(() => cashSessions.close(session.id, { closeAmount: 50000 }, shiftCashier));
    await expect(run(() => payments.reverse(p3.id, 'after close', shiftCashier))).rejects.toBeInstanceOf(PaymentInClosedCashSessionException);
    const closed = await run(() => cashSessions.list({ page: 1, pageSize: 10, userId: shiftCashier.id }));
    expect(closed.data[0]!.totalCollected.toString()).toBe('50000');

    // A closed shift cannot receive a handover (no own open shift).
    const p4 = await run(() => payments.create({ customerId, amount: 1000, method: 'CASH' }, agent));
    await expect(run(() => payments.acceptHandover(p4.id, shiftCashier))).rejects.toBeInstanceOf(PaymentHandoverNoOpenCashSessionException);
  });
});
