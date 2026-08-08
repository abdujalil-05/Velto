import { Injectable } from '@nestjs/common';
import { InvoiceStatus, Prisma, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import { paginate, resolveSort } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { endOfDay, startOfDay } from '../../analytics/report-utils';
import { CustomersService } from '../../customers/customers.service';
import type { CreatePaymentDto, PaymentAllocationInputDto } from '../dto/create-payment.dto';
import type { ListPaymentsQueryDto } from '../dto/list-payments.query';
import {
  AllocationExceedsInvoiceException,
  AllocationExceedsPaymentException,
  InvalidPaymentAmountException,
  InvoiceNotFoundException,
  PaymentNotFoundException,
} from '../finance-exceptions';

// customer is included alongside allocations so the web UI (9.2 "/payments")
// can render a full row without an extra round-trip per payment.
const PAYMENT_INCLUDE = {
  allocations: { include: { invoice: true } },
  customer: { select: { id: true, name: true, code: true } },
} satisfies Prisma.PaymentInclude;
type InvoiceWithAllocations = Prisma.InvoiceGetPayload<{ include: { allocations: true } }>;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly customers: CustomersService,
    private readonly docNumbering: DocumentNumberingService,
  ) {}

  async list(query: ListPaymentsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.PaymentWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.collectedBy ? { collectedBy: query.collectedBy } : {}),
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

    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const tx = this.tenantPrisma.client;
    const payment = await tx.payment.findFirst({ where: { id }, include: PAYMENT_INCLUDE });
    if (!payment) throw new PaymentNotFoundException();
    return payment;
  }

  /**
   * F-M05 / 8.4: auto-allocates FIFO across the customer's oldest open
   * invoices, unless the caller supplies an explicit `allocations` array
   * (manual override — "operator qo'lda taqsimlashni o'zgartira oladi").
   * Any amount left over once every open invoice is settled is simply not
   * allocated (no PaymentAllocation row) — 6.7's balance formula only sums
   * PaymentAllocation, so an over-payment doesn't retroactively invent an
   * invoice to attach to; it just sits as a visible, unapplied credit on
   * this payment until a future invoice/payment allocates it.
   * 10.4 offline idempotency: a resubmitted clientId returns the original
   * payment instead of creating a duplicate.
   */
  async create(dto: CreatePaymentDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    if (dto.clientId) {
      const existing = await tx.payment.findUnique({ where: { clientId: dto.clientId }, include: PAYMENT_INCLUDE });
      if (existing) return existing;
    }

    const amount = new Prisma.Decimal(dto.amount);
    if (!amount.greaterThan(0)) {
      throw new InvalidPaymentAmountException("To'lov summasi musbat bo'lishi kerak");
    }

    await this.customers.findActiveOrThrow(tx, dto.customerId);

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
        const existing = await tx.payment.findUnique({ where: { clientId: dto.clientId }, include: PAYMENT_INCLUDE });
        if (existing) return existing;
      }
      throw err;
    }

    if (dto.allocations?.length) {
      await this.allocateManual(tx, { id: payment.id, customerId: payment.customerId, amount }, dto.allocations);
    } else {
      await this.allocateFifo(tx, { id: payment.id, customerId: payment.customerId, amount });
    }

    // 6.7: "hech qachon to'g'ridan-to'g'ri UPDATE qilinmaydi" outside of a
    // recompute from the ledger — done here, inside the same transaction.
    const balance = await this.customers.getBalance(tx, dto.customerId);
    await tx.customer.update({ where: { id: dto.customerId }, data: { cachedBalance: balance } });

    const full = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: PAYMENT_INCLUDE });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'payment.create',
      entity: 'Payment',
      entityId: payment.id,
      newValue: toAuditJson(full),
    });

    return full;
  }

  private async allocateFifo(
    tx: TenantClient,
    payment: { id: string; customerId: string; amount: Prisma.Decimal },
  ): Promise<void> {
    let remaining = payment.amount;
    const openInvoiceIds = await tx.invoice.findMany({
      where: { customerId: payment.customerId, status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIALLY_PAID] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
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
      remaining = remaining.minus(toAllocate);
    }
  }

  private async allocateManual(
    tx: TenantClient,
    payment: { id: string; customerId: string; amount: Prisma.Decimal },
    inputs: PaymentAllocationInputDto[],
  ): Promise<void> {
    const requestedTotal = inputs.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
    if (requestedTotal.greaterThan(payment.amount)) {
      throw new AllocationExceedsPaymentException(payment.amount.toString(), requestedTotal.toString());
    }

    for (const input of inputs) {
      const invoice = await this.lockAndFetchInvoice(tx, input.invoiceId);
      // Unlike allocateFifo's query above, this lookup isn't pre-filtered by
      // status — re-check it here so a CANCELLED (or already-PAID) invoice
      // can't be manually targeted and flipped back to PAID/PARTIALLY_PAID.
      if (invoice.customerId !== payment.customerId || (invoice.status !== InvoiceStatus.OPEN && invoice.status !== InvoiceStatus.PARTIALLY_PAID)) {
        throw new InvoiceNotFoundException();
      }

      const outstanding = outstandingOf(invoice);
      const requested = new Prisma.Decimal(input.amount);
      if (requested.greaterThan(outstanding)) {
        throw new AllocationExceedsInvoiceException(invoice.number, outstanding.toString(), requested.toString());
      }

      await this.applyAllocation(tx, payment.id, invoice.id, requested, outstanding);
    }
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
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { allocations: true } });
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

function outstandingOf(invoice: InvoiceWithAllocations): Prisma.Decimal {
  const allocated = invoice.allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
  return invoice.total.minus(allocated);
}
