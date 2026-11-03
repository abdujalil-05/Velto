import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../../common/auth/auth.types';
import { AuditLogService } from '../../../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../../../common/document-numbering/document-numbering.service';
import type { AppException } from '../../../../common/errors/app-exception';
import { TenantPrismaService } from '../../../../common/tenant/tenant-prisma.service';
import { runWithTraceId } from '../../../../common/trace/trace-context';
import { CustomersService } from '../../../customers/customers.service';
import { makeOwnerAlerts } from '../../../notifications/test-owner-alerts';
import { CashSessionsService } from '../../cash-sessions/cash-sessions.service';
import {
  PaymentIdempotencyConflictException,
  PaymentReconciliationContradictionException,
  PaymentReconciliationEvidenceRequiredException,
  PaymentReconciliationNoRejectedIntentException,
  PaymentReconciliationPaymentNotFoundException,
} from '../../finance-exceptions';
import { PaymentsService } from '../payments.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';

/** PO 2026-11-02: reconciliation of rejected offline payment intents (real Postgres + RLS). */
describe('Payment intent reconciliation (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let companyB: string;
  let seq = 0;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService(), makeOwnerAlerts(tenantPrisma));
  const cashSessions = new CashSessionsService(tenantPrisma, auditLog);
  const recon = new PaymentReconciliationService(tenantPrisma, auditLog);
  const run = <T>(fn: () => Promise<T>, cid = companyId) => tenantPrisma.run(cid, fn);

  let agent: AuthenticatedUser;
  let agent2: AuthenticatedUser;
  let cashier: AuthenticatedUser;
  let ownerB: AuthenticatedUser;

  async function newUser(cid: string, roles: string[]): Promise<AuthenticatedUser> {
    const u = await systemPrisma.user.create({
      data: { companyId: cid, firstName: roles.join('-'), lastName: `R${++seq}`, phone: `+99896${Math.floor(1_000_000 + Math.random() * 8_999_999)}` },
    });
    return { id: u.id, companyId: cid, firstName: u.firstName, lastName: u.lastName, roles, permissions: [] };
  }

  async function customerWithInvoice() {
    return tenantPrisma.run(companyId, async (tx) => {
      const c = await tx.customer.create({ data: { companyId, code: `RC-${Date.now()}-${++seq}`, name: 'Recon Customer' } });
      await tx.invoice.create({ data: { companyId, number: `RC-INV-${Date.now()}-${++seq}`, customerId: c.id, total: '50000', status: 'OPEN' } });
      return c.id;
    });
  }

  /** Payment by `by`, then a conflicting replay by the same user -> 409 + `payment.create_rejected` audit. */
  async function rejectedIntent(by: AuthenticatedUser) {
    const customerId = await customerWithInvoice();
    const clientId = randomUUID();
    const payment = await run(() => payments.create({ customerId, amount: 20000, method: 'CASH', clientId }, by));
    await expect(run(() => payments.create({ customerId, amount: 20001, method: 'CASH', clientId }, by))).rejects.toBeInstanceOf(
      PaymentIdempotencyConflictException,
    );
    return { customerId, clientId, paymentId: payment.id };
  }

  const confirm = (clientId: string, outcome: 'EXISTING_PAYMENT_CONFIRMED' | 'NOT_POSTED_CONFIRMED', user = cashier, cid = companyId) =>
    run(
      () =>
        recon.confirm(
          { clientId, outcome, reason: 'Kassa hujjati bilan solishtirildi', evidenceRef: outcome === 'NOT_POSTED_CONFIRMED' ? 'BANK-STMT-42' : undefined },
          user,
        ),
      cid,
    );

  /** Every money/stock fact a reconciliation must never touch. */
  const moneySnapshot = (customerId: string, paymentId: string) =>
    tenantPrisma.run(companyId, async (tx) => ({
      payment: await tx.payment.findUniqueOrThrow({ where: { id: paymentId } }),
      allocations: await tx.paymentAllocation.findMany({ where: { payment: { customerId } }, orderBy: { id: 'asc' } }),
      invoices: await tx.invoice.findMany({ where: { customerId }, orderBy: { id: 'asc' } }),
      reversals: await tx.paymentReversal.count({ where: { reversesPaymentId: paymentId } }),
      cachedBalance: (await tx.customer.findUniqueOrThrow({ where: { id: customerId } })).cachedBalance.toString(),
      balance: (await customers.getBalance(tx, customerId)).toString(),
      paymentsInCompany: await tx.payment.count(),
      stockMovements: await tx.stockMovement.count(),
      cashSessions: await tx.cashSession.findMany({ orderBy: { id: 'asc' } }),
    }));

  const resolutionCount = (clientId: string) => run(() => tenantPrisma.client.paymentIntentResolution.count({ where: { clientId } }));
  const reconcileAudits = (paymentId: string) =>
    run(() => tenantPrisma.client.auditLog.findMany({ where: { action: 'payment.reconcile', entityId: paymentId } }));

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-recon-${Date.now()}`, name: 'Recon Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Recon Co' } })).id;
    companyB = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Recon Co B' } })).id;
    agent = await newUser(companyId, ['SALES_AGENT']);
    agent2 = await newUser(companyId, ['SALES_AGENT']);
    cashier = await newUser(companyId, ['CASHIER']);
    ownerB = await newUser(companyB, ['OWNER']);
    await run(() => cashSessions.open({ openAmount: 0 }, cashier));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('confirm writes one resolution + payment.reconcile audit with traceId; money/stock untouched; identical repeat is idempotent', async () => {
    const { customerId, clientId, paymentId } = await rejectedIntent(cashier);
    const before = await moneySnapshot(customerId, paymentId);
    const traceId = `trace-recon-${randomUUID()}`;

    const first = await runWithTraceId(traceId, () => confirm(clientId, 'EXISTING_PAYMENT_CONFIRMED'));
    expect(first.replayed).toBe(false);
    expect(first.resolution).toMatchObject({ clientId, paymentId, outcome: 'EXISTING_PAYMENT_CONFIRMED', actorId: cashier.id, originalUserId: cashier.id, traceId });
    expect(first.resolution.rejectionAuditId).toBeTruthy();
    expect(first.snapshot.id).toBe(paymentId);
    expect(first.snapshot.allocations.map((a) => a.amount.toString())).toEqual(['20000']);

    const again = await confirm(clientId, 'EXISTING_PAYMENT_CONFIRMED');
    expect(again.replayed).toBe(true);
    expect(again.resolution.id).toBe(first.resolution.id);
    expect(await resolutionCount(clientId)).toBe(1);

    const audits = await reconcileAudits(paymentId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.traceId).toBe(traceId);
    expect(audits[0]!.userId).toBe(cashier.id);
    expect(audits[0]!.newValue).toMatchObject({ clientId, outcome: 'EXISTING_PAYMENT_CONFIRMED', traceId, resolutionId: first.resolution.id });

    expect(await moneySnapshot(customerId, paymentId)).toEqual(before);
  });

  it('different outcome after a decision -> 409 PAYMENT_RECONCILIATION_CONTRADICTION, nothing written', async () => {
    const { clientId, paymentId } = await rejectedIntent(cashier);
    await confirm(clientId, 'NOT_POSTED_CONFIRMED');
    const err = await confirm(clientId, 'EXISTING_PAYMENT_CONFIRMED').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentReconciliationContradictionException);
    expect((err as AppException).getStatus()).toBe(409);
    expect(await resolutionCount(clientId)).toBe(1);
    expect(await reconcileAudits(paymentId)).toHaveLength(1);
  });

  it('NOT_POSTED_CONFIRMED without evidenceRef -> 400', async () => {
    const { clientId } = await rejectedIntent(cashier);
    await expect(run(() => recon.confirm({ clientId, outcome: 'NOT_POSTED_CONFIRMED', reason: 'Bank ko\'chirmasida yo\'q' }, cashier))).rejects.toBeInstanceOf(
      PaymentReconciliationEvidenceRequiredException,
    );
    expect(await resolutionCount(clientId)).toBe(0);
  });

  it('concurrent contradictory confirms -> exactly one row, one audit, the loser gets 409', async () => {
    const { clientId, paymentId } = await rejectedIntent(cashier);
    const results = await Promise.allSettled([confirm(clientId, 'EXISTING_PAYMENT_CONFIRMED'), confirm(clientId, 'NOT_POSTED_CONFIRMED')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(PaymentReconciliationContradictionException);
    expect(await resolutionCount(clientId)).toBe(1);
    expect(await reconcileAudits(paymentId)).toHaveLength(1);
  });

  it('no rejection audit -> 409 (never inferred); unknown clientId -> 404', async () => {
    const customerId = await customerWithInvoice();
    const clientId = randomUUID();
    await run(() => payments.create({ customerId, amount: 1000, method: 'CASH', clientId }, cashier));
    await expect(confirm(clientId, 'NOT_POSTED_CONFIRMED')).rejects.toBeInstanceOf(PaymentReconciliationNoRejectedIntentException);
    await expect(confirm(randomUUID(), 'EXISTING_PAYMENT_CONFIRMED')).rejects.toBeInstanceOf(PaymentReconciliationPaymentNotFoundException);
    expect(await resolutionCount(clientId)).toBe(0);
  });

  it('OWNER of company B cannot confirm a company A clientId (404, nothing written)', async () => {
    const { clientId } = await rejectedIntent(cashier);
    await expect(confirm(clientId, 'EXISTING_PAYMENT_CONFIRMED', ownerB, companyB)).rejects.toBeInstanceOf(
      PaymentReconciliationPaymentNotFoundException,
    );
    expect(await resolutionCount(clientId)).toBe(0);
    expect(await tenantPrisma.run(companyB, (tx) => tx.paymentIntentResolution.count())).toBe(0);
  });

  it('agent status: own intents OPEN -> resolved outcome; other agent / unknown / other tenant -> UNKNOWN', async () => {
    const mine = await rejectedIntent(agent);
    const theirs = await rejectedIntent(agent2);
    const unknown = randomUUID();

    const open = await run(() => recon.status({ clientIds: [mine.clientId, theirs.clientId, unknown] }, agent));
    expect(open.items).toEqual([
      { clientId: mine.clientId, status: 'OPEN' },
      { clientId: theirs.clientId, status: 'UNKNOWN' },
      { clientId: unknown, status: 'UNKNOWN' },
    ]);

    await confirm(mine.clientId, 'NOT_POSTED_CONFIRMED');
    await confirm(theirs.clientId, 'EXISTING_PAYMENT_CONFIRMED');
    const after = await run(() => recon.status({ clientIds: [mine.clientId, theirs.clientId] }, agent));
    expect(after.items[0]).toMatchObject({ clientId: mine.clientId, status: 'NOT_POSTED_CONFIRMED' });
    expect(after.items[0]!.resolvedAt).toBeInstanceOf(Date);
    expect(after.items[1]).toEqual({ clientId: theirs.clientId, status: 'UNKNOWN' });

    const otherTenant = await tenantPrisma.run(companyB, () => recon.status({ clientIds: [mine.clientId] }, ownerB));
    expect(otherTenant.items).toEqual([{ clientId: mine.clientId, status: 'UNKNOWN' }]);
  });

  it('list OPEN excludes resolved intents; RESOLVED lists the decision', async () => {
    const a = await rejectedIntent(cashier);
    const b = await rejectedIntent(cashier);
    await confirm(b.clientId, 'EXISTING_PAYMENT_CONFIRMED');
    const open = await run(() => recon.list({ page: 1, pageSize: 100, status: 'OPEN' }, cashier));
    const openIds = open.data.map((r) => r.clientId);
    expect(openIds).toContain(a.clientId);
    expect(openIds).not.toContain(b.clientId);
    expect(open.meta.total).toBe(open.data.length);
    const resolved = await run(() => recon.list({ page: 1, pageSize: 100, status: 'RESOLVED' }, cashier));
    expect(resolved.data.map((r) => r.clientId)).toContain(b.clientId);
  });

  it('list is agent-scoped: agent sees only own intents (OPEN + RESOLVED); cashier sees all', async () => {
    const mine = await rejectedIntent(agent);
    const theirs = await rejectedIntent(agent2);
    const ids = async (status: 'OPEN' | 'RESOLVED', u: AuthenticatedUser) =>
      (await run(() => recon.list({ page: 1, pageSize: 100, status }, u))).data.map((r) => r.clientId);
    const openAgent = await ids('OPEN', agent);
    expect(openAgent).toContain(mine.clientId);
    expect(openAgent).not.toContain(theirs.clientId);
    const openCashier = await ids('OPEN', cashier);
    expect(openCashier).toEqual(expect.arrayContaining([mine.clientId, theirs.clientId]));
    await confirm(mine.clientId, 'EXISTING_PAYMENT_CONFIRMED');
    await confirm(theirs.clientId, 'EXISTING_PAYMENT_CONFIRMED');
    const resAgent = await ids('RESOLVED', agent);
    expect(resAgent).toContain(mine.clientId);
    expect(resAgent).not.toContain(theirs.clientId);
    expect(await ids('RESOLVED', cashier)).toEqual(expect.arrayContaining([mine.clientId, theirs.clientId]));
  });

  it('after a decision the payment idempotency gate is unchanged: identical replay returns the payment, changed replay still 409', async () => {
    const { customerId, clientId, paymentId } = await rejectedIntent(cashier);
    await confirm(clientId, 'NOT_POSTED_CONFIRMED');
    const before = await moneySnapshot(customerId, paymentId);
    const replay = await run(() => payments.create({ customerId, amount: 20000, method: 'CASH', clientId }, cashier));
    expect(replay.id).toBe(paymentId);
    await expect(run(() => payments.create({ customerId, amount: 20002, method: 'CASH', clientId }, cashier))).rejects.toBeInstanceOf(
      PaymentIdempotencyConflictException,
    );
    expect(await moneySnapshot(customerId, paymentId)).toEqual(before);
  });
});
