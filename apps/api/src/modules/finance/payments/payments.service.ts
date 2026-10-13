import { Injectable } from '@nestjs/common';
import { assertClientIdReplayAllowed } from '../../../common/idempotency/client-id-replay';
import { InvoiceStatus, PaymentMethod, PaymentStatus, Prisma, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AppException } from '../../../common/errors/app-exception';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import { paginate, resolveSort } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { endOfDay, startOfDay } from '../../analytics/report-utils';
import { CustomersService } from '../../customers/customers.service';
import type { AllocatePaymentDto } from '../dto/allocate-payment.dto';
import type { CreatePaymentDto } from '../dto/create-payment.dto';
import type { ListPaymentsQueryDto } from '../dto/list-payments.query';
import {
  AllocationExceedsAdvanceException,
  AllocationExceedsInvoiceException,
  AllocationExceedsPaymentException,
  InvalidPaymentAmountException,
  InvoiceNotFoundException,
  PaymentAlreadyReversedException,
  PaymentExportedTo1cException,
  PaymentInClosedCashSessionException,
  PaymentNotFoundException,
  PaymentNotPostedException,
  PaymentReversalReasonRequiredException,
} from '../finance-exceptions';
import { VALID_ALLOCATION_WHERE, paymentAdvanceOf } from '../ledger-filters';

// customer is included alongside allocations so the web UI (9.2 "/payments")
// can render a full row without an extra round-trip per payment.
const PAYMENT_INCLUDE = {
  allocations: { include: { invoice: true } },
  customer: { select: { id: true, name: true, code: true } },
} satisfies Prisma.PaymentInclude;
type InvoiceWithAllocations = Prisma.InvoiceGetPayload<{ include: { allocations: true } }>;
type PaymentWithIncludes = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

/** F2.1: every payment response carries `advance` (unapplied POSTED amount, Decimal string). */
function withAdvance<T extends PaymentWithIncludes>(payment: T): T & { advance: string } {
  return { ...payment, advance: paymentAdvanceOf(payment).toString() };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly customers: CustomersService,
    private readonly docNumbering: DocumentNumberingService,
  ) {}

  async list(query: ListPaymentsQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // SEC-023 (15.3): a SALES_AGENT only ever sees the payments they
    // collected themselves — this overrides whatever `collectedBy` they
    // passed, so they can't page through the company's cash collection by
    // guessing another user's id. CASHIER/ACCOUNTANT/DIRECTOR/OWNER are
    // unrestricted (their whole job is the company-wide cash picture).
    const scopedCollectedBy = user.roles.includes('SALES_AGENT') ? user.id : query.collectedBy;
    const where: Prisma.PaymentWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(scopedCollectedBy ? { collectedBy: scopedCollectedBy } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
              ...(query.to ? { lte: endOfDay(new Date(query.to)) } : {}),
            },
          }
        : {}),
    };

    const orderBy = resolveSort<Prisma.PaymentOrderByWithRelationInput>(
      query,
      {
        number: (dir) => ({ number: dir }),
        createdAt: (dir) => ({ createdAt: dir }),
        amount: (dir) => ({ amount: dir }),
      },
      { createdAt: 'desc' },
    );

    const [data, total] = await Promise.all([
      tx.payment.findMany({
        where,
        include: PAYMENT_INCLUDE,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.payment.count({ where }),
    ]);

    return paginate(data.map(withAdvance), total, query.page, query.pageSize);
  }

  async getById(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // SEC-023: same object-level scoping as list() — another collector's
    // payment id returns the same "not found" as a bad id, so the response
    // never confirms that payment exists.
    const scopedCollectedBy = user.roles.includes('SALES_AGENT') ? user.id : undefined;
    const payment = await tx.payment.findFirst({
      where: { id, ...(scopedCollectedBy ? { collectedBy: scopedCollectedBy } : {}) },
      include: PAYMENT_INCLUDE,
    });
    if (!payment) throw new PaymentNotFoundException();
    return withAdvance(payment);
  }

  /**
   * F-M05 / 8.4: auto-allocates FIFO across the customer's oldest open
   * invoices, unless the caller supplies an explicit `allocations` array
   * (manual override — "operator qo'lda taqsimlashni o'zgartira oladi").
   * Any amount left over once every open invoice is settled is simply not
   * allocated (no PaymentAllocation row): it is the payment's `advance`
   * (avans), counted in the customer balance as credit (negative balance on
   * over-payment) and never auto-applied to a later invoice — only manually.
   * 10.4 offline idempotency: a resubmitted clientId returns the original
   * payment instead of creating a duplicate.
   */
  async create(dto: CreatePaymentDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    if (dto.clientId) {
      const existing = await tx.payment.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: PAYMENT_INCLUDE });
      if (existing) {
        assertClientIdReplayAllowed(existing.collectedBy, user);
        return withAdvance(existing);
      }
    }

    const amount = new Prisma.Decimal(dto.amount);
    if (!amount.greaterThan(0)) {
      throw new InvalidPaymentAmountException("To'lov summasi musbat bo'lishi kerak");
    }

    // Customer row lock FIRST, then the deletedAt check as a fresh read: a
    // concurrent CustomersService.remove() holds the same lock, so either it
    // commits first (we see deletedAt -> CustomerNotFound) or we commit first
    // (its ledger read sees this payment -> balance != 0, delete refused).
    // Lock order customer -> invoices; allocate()/reverse() take the customer
    // lock before invoices too, so no lock-order inversion between them.
    await this.customers.lockActiveOrThrow(tx, dto.customerId);

    const number = await this.docNumbering.next(tx, user.companyId, 'PAY');
    let payment;
    try {
      // SAVEPOINT: a P2002 below aborts the whole request transaction at the
      // Postgres level, so without a savepoint the recovery findUnique just
      // after this catch would itself fail instead of finding the winner.
      payment = await withSavepoint(tx, 'payment_create', () =>
        tx.payment.create({
          data: {
            companyId: user.companyId,
            number,
            customerId: dto.customerId,
            amount,
            method: dto.method,
            collectedBy: user.id,
            clientId: dto.clientId,
          },
        }),
      );
    } catch (err) {
      // 10.4: the exact "flaky connection, client retries" scenario clientId
      // exists for — both requests can race past the pre-check above and the
      // loser hits this unique violation. Return the winner's payment.
      if (dto.clientId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await tx.payment.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: PAYMENT_INCLUDE });
        if (existing) {
          assertClientIdReplayAllowed(existing.collectedBy, user);
          return withAdvance(existing);
        }
      }
      throw err;
    }

    const mode = dto.allocations?.length ? 'MANUAL' : 'FIFO';
    const allocations = dto.allocations?.length
      ? await this.allocateManual(tx, { id: payment.id, customerId: payment.customerId }, amount, dto.allocations, (cap, req) => new AllocationExceedsPaymentException(cap, req))
      : await this.allocateFifo(tx, { id: payment.id, customerId: payment.customerId, amount });

    // 6.7: "hech qachon to'g'ridan-to'g'ri UPDATE qilinmaydi" outside of a
    // recompute from the ledger — done here, inside the same transaction.
    await this.refreshCachedBalance(tx, dto.customerId);

    const full = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: PAYMENT_INCLUDE });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'payment.create',
      entity: 'Payment',
      entityId: payment.id,
      newValue: toAuditJson(full),
    });

    // TZ 11.4: allocation is its own mandatory audit event, separate from
    // payment.create. Skipped when nothing was allocated (pure advance).
    if (allocations.length) {
      await this.auditLog.log(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: 'payment.allocate',
        entity: 'Payment',
        entityId: payment.id,
        newValue: toAuditJson({ mode, allocations }),
      });
    }

    return withAdvance(full);
  }

  /**
   * F2.1 / §6.5: manually applies (part of) an existing POSTED payment's
   * advance to the same customer's live invoices. Append-only: new
   * PaymentAllocation rows only. Lock order = reverse(): payment FOR UPDATE
   * (serializes two allocations of one advance) -> customer -> invoices
   * (createdAt, id asc). Σamount ≤ advance read under the payment lock.
   */
  async allocate(paymentId: string, dto: AllocatePaymentDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Payment" WHERE id = ${paymentId}::uuid FOR UPDATE`);
    // Only `payments.allocate` holders reach here (no SALES_AGENT), so no
    // collectedBy scoping; tenant isolation is RLS on the tenant tx.
    // Closed cash session / 1C-exported payments are deliberately allowed:
    // allocating an advance moves no cash and adds append-only rows only.
    const before = await tx.payment.findUnique({ where: { id: paymentId }, include: PAYMENT_INCLUDE });
    if (!before) throw new PaymentNotFoundException();
    if (before.status !== PaymentStatus.POSTED) throw new PaymentNotPostedException(before.status);
    await this.customers.lockForUpdate(tx, before.customerId);

    const advanceBefore = paymentAdvanceOf(before);
    const allocations = await this.allocateManual(
      tx,
      { id: before.id, customerId: before.customerId },
      advanceBefore,
      dto.allocations,
      (cap, req) => new AllocationExceedsAdvanceException(cap, req),
    );

    await this.refreshCachedBalance(tx, before.customerId);

    const full = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: PAYMENT_INCLUDE });
    const result = withAdvance(full);
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'payment.allocate',
      entity: 'Payment',
      entityId: paymentId,
      oldValue: toAuditJson({ advance: advanceBefore.toString() }),
      newValue: toAuditJson({ mode: 'MANUAL_LATER', allocations, advance: result.advance }),
    });
    return result;
  }

  /**
   * F2.1 / §6.5: reverses a POSTED payment. Nothing is deleted or edited
   * except Payment.status POSTED -> REVERSED (DB trigger requires the
   * PaymentReversal row first); its allocation rows stay and simply stop
   * counting (VALID_ALLOCATION_WHERE). Lock order matches create()/allocate():
   * payment -> customer -> invoices (createdAt asc), so no deadlock with a
   * concurrent allocation or new payment.
   */
  async reverse(paymentId: string, reason: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const trimmedReason = reason?.trim() ?? '';
    if (trimmedReason.length < 3) throw new PaymentReversalReasonRequiredException();

    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Payment" WHERE id = ${paymentId}::uuid FOR UPDATE`);
    const before = await tx.payment.findUnique({ where: { id: paymentId }, include: PAYMENT_INCLUDE });
    if (!before) throw new PaymentNotFoundException();
    if (before.status === PaymentStatus.REVERSED) throw new PaymentAlreadyReversedException();
    await this.customers.lockForUpdate(tx, before.customerId);

    await this.assertNotInClosedCashSession(tx, before);
    await this.assertNotExportedTo1c(tx, before.createdAt);

    await tx.paymentReversal.create({
      data: { companyId: user.companyId, reversesPaymentId: paymentId, reason: trimmedReason, actorId: user.id },
    });
    await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.REVERSED } });

    const invoiceIds = await tx.invoice.findMany({
      where: { allocations: { some: { paymentId } } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const { id } of invoiceIds) {
      const invoice = await this.lockAndFetchInvoice(tx, id);
      if (invoice.status === InvoiceStatus.CANCELLED) continue;
      await tx.invoice.update({ where: { id }, data: { status: statusFor(invoice) } });
    }

    await this.refreshCachedBalance(tx, before.customerId);

    const full = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: PAYMENT_INCLUDE });
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'payment.reverse',
      entity: 'Payment',
      entityId: paymentId,
      oldValue: toAuditJson(before),
      newValue: toAuditJson({ status: full.status, reason: trimmedReason }),
    });
    return withAdvance(full);
  }

  /**
   * "Yopilgan smenaga kirgan to'lov" uses the exact membership rule
   * CashSessionsService.withSummary counts by: CASH, collectedBy = session
   * user, createdAt within [openedAt, closedAt]. FOR SHARE makes a concurrent
   * close() wait for this transaction (or, if it committed first, the
   * re-checked row is seen as closed).
   */
  private async assertNotInClosedCashSession(
    tx: TenantClient,
    payment: { method: PaymentMethod; collectedBy: string | null; createdAt: Date },
  ): Promise<void> {
    if (payment.method !== PaymentMethod.CASH || !payment.collectedBy) return;
    const sessions = await tx.$queryRaw<{ id: string; closedAt: Date | null }[]>(Prisma.sql`
      SELECT id, "closedAt" FROM "CashSession"
      WHERE "userId" = ${payment.collectedBy}::uuid
        AND "openedAt" <= ${payment.createdAt}
        AND ("closedAt" IS NULL OR "closedAt" >= ${payment.createdAt})
      FOR SHARE
    `);
    const closed = sessions.find((s) => s.closedAt !== null);
    if (closed) throw new PaymentInClosedCashSessionException(closed.id);
  }

  /**
   * Export1cProcessor exports every payment with createdAt within
   * [periodFrom, periodTo] of the job. A PENDING/PROCESSING job will, and a
   * DONE job did, include it — only FAILED jobs exported nothing.
   */
  private async assertNotExportedTo1c(tx: TenantClient, createdAt: Date): Promise<void> {
    const job = await tx.exportJob.findFirst({
      where: { type: '1c', status: { not: 'FAILED' }, periodFrom: { lte: createdAt }, periodTo: { gte: createdAt } },
      select: { id: true },
    });
    if (job) throw new PaymentExportedTo1cException(job.id);
  }

  /**
   * §6.5: cachedBalance recomputed from the ledger in the same tx. The
   * customer row is locked first so two concurrent ledger writes for one
   * customer (payment vs reversal) serialize and the later one recomputes
   * from the other's committed rows — no stale overwrite.
   */
  private async refreshCachedBalance(tx: TenantClient, customerId: string): Promise<void> {
    await this.customers.lockForUpdate(tx, customerId); // already held by every caller — re-entrant no-op
    const balance = await this.customers.getBalance(tx, customerId);
    await tx.customer.update({ where: { id: customerId }, data: { cachedBalance: balance } });
  }

  private async allocateFifo(
    tx: TenantClient,
    payment: { id: string; customerId: string; amount: Prisma.Decimal },
  ): Promise<AllocationResult[]> {
    const results: AllocationResult[] = [];
    let remaining = payment.amount;
    const openInvoiceIds = await tx.invoice.findMany({
      where: { customerId: payment.customerId, status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIALLY_PAID] } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    for (const { id: invoiceId } of openInvoiceIds) {
      // Decimal.isPositive() is sign-based and true for zero too — use an
      // explicit > 0 comparison so a fully-spent `remaining` actually stops
      // the loop instead of falling through to a spurious 0-amount allocation.
      if (!remaining.greaterThan(0)) break;

      // Lock+refetch per invoice, right before using it — a stale snapshot
      // read once for the whole loop (the old behavior) is exactly what let
      // two concurrent payments both compute the same `outstanding` and
      // together over-allocate past an invoice's total.
      const invoice = await this.lockAndFetchInvoice(tx, invoiceId);
      const outstanding = outstandingOf(invoice);
      if (!outstanding.greaterThan(0)) continue;

      const toAllocate = outstanding.lessThan(remaining) ? outstanding : remaining;
      await this.applyAllocation(tx, payment.id, invoice.id, toAllocate, outstanding);
      results.push({ invoiceId: invoice.id, invoiceNumber: invoice.number, amount: toAllocate.toString() });
      remaining = remaining.minus(toAllocate);
    }
    return results;
  }

  /**
   * Manual allocation shared by create() (cap = payment amount) and
   * allocate() (cap = advance). Duplicate invoice lines are merged; invoices
   * are locked in (createdAt, id) order — the same order as allocateFifo and
   * reverse() — so concurrent ledger writers never deadlock.
   */
  private async allocateManual(
    tx: TenantClient,
    payment: { id: string; customerId: string },
    cap: Prisma.Decimal,
    inputs: { invoiceId: string; amount: Prisma.Decimal.Value }[],
    exceeds: (cap: string, requested: string) => AppException,
  ): Promise<AllocationResult[]> {
    const requestedByInvoice = new Map<string, Prisma.Decimal>();
    for (const input of inputs) {
      const prev = requestedByInvoice.get(input.invoiceId) ?? new Prisma.Decimal(0);
      requestedByInvoice.set(input.invoiceId, prev.plus(input.amount));
    }
    const requestedTotal = [...requestedByInvoice.values()].reduce((sum, a) => sum.plus(a), new Prisma.Decimal(0));
    if (requestedTotal.greaterThan(cap)) throw exceeds(cap.toString(), requestedTotal.toString());

    const ordered = await tx.invoice.findMany({
      where: { id: { in: [...requestedByInvoice.keys()] } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (ordered.length !== requestedByInvoice.size) throw new InvoiceNotFoundException();

    const results: AllocationResult[] = [];
    for (const { id: invoiceId } of ordered) {
      const invoice = await this.lockAndFetchInvoice(tx, invoiceId);
      // Unlike allocateFifo's query above, this lookup isn't pre-filtered by
      // status — re-check it here so a CANCELLED (or already-PAID) invoice
      // can't be manually targeted and flipped back to PAID/PARTIALLY_PAID.
      if (invoice.customerId !== payment.customerId || (invoice.status !== InvoiceStatus.OPEN && invoice.status !== InvoiceStatus.PARTIALLY_PAID)) {
        throw new InvoiceNotFoundException();
      }

      const outstanding = outstandingOf(invoice);
      const requested = requestedByInvoice.get(invoiceId)!;
      if (requested.greaterThan(outstanding)) {
        throw new AllocationExceedsInvoiceException(invoice.number, outstanding.toString(), requested.toString());
      }

      await this.applyAllocation(tx, payment.id, invoice.id, requested, outstanding);
      results.push({ invoiceId: invoice.id, invoiceNumber: invoice.number, amount: requested.toString() });
    }
    return results;
  }

  /**
   * `SELECT ... FOR UPDATE` on the invoice row, then a fresh read of it plus
   * its allocations — serializes concurrent allocation attempts against the
   * *same* invoice (the second caller blocks until the first's transaction
   * commits, then sees its committed allocations), the same technique
   * `StockService.lockStockLevel` uses for reservations.
   */
  private async lockAndFetchInvoice(tx: TenantClient, invoiceId: string): Promise<InvoiceWithAllocations> {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Invoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`);
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { allocations: { where: VALID_ALLOCATION_WHERE } } });
    if (!invoice) throw new InvoiceNotFoundException();
    return invoice;
  }

  private async applyAllocation(
    tx: TenantClient,
    paymentId: string,
    invoiceId: string,
    amount: Prisma.Decimal,
    outstandingBefore: Prisma.Decimal,
  ): Promise<void> {
    await tx.paymentAllocation.create({ data: { paymentId, invoiceId, amount } });
    const remainder = outstandingBefore.minus(amount);
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: remainder.isZero() ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID },
    });
  }
}

interface AllocationResult {
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
}

function statusFor(invoice: InvoiceWithAllocations): InvoiceStatus {
  const outstanding = outstandingOf(invoice);
  if (!outstanding.greaterThan(0)) return InvoiceStatus.PAID;
  return outstanding.equals(invoice.total) ? InvoiceStatus.OPEN : InvoiceStatus.PARTIALLY_PAID;
}

function outstandingOf(invoice: InvoiceWithAllocations): Prisma.Decimal {
  const allocated = invoice.allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
  return invoice.total.minus(allocated);
}
