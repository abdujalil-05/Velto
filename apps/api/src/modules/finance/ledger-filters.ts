import { InvoiceStatus, PaymentStatus, Prisma } from '@velto/database';

/**
 * F2.1 / §6.5 "valid allocations": a PaymentAllocation counts toward an
 * invoice's paid amount / a customer's balance only while its payment is
 * POSTED. A reversed payment keeps its allocation rows (append-only) but they
 * stop counting. Every ledger read must use this one predicate.
 */
export const VALID_ALLOCATION_WHERE = {
  payment: { status: PaymentStatus.POSTED },
} satisfies Prisma.PaymentAllocationWhereInput;

/** Only POSTED payments are money the customer has actually paid (REVERSED never counts). */
export const POSTED_PAYMENT_WHERE = {
  status: PaymentStatus.POSTED,
} satisfies Prisma.PaymentWhereInput;

/**
 * F2.1 / §6.5 advance (avans): the part of a POSTED payment not applied to a
 * live (non-CANCELLED) invoice. Never auto-applied to later invoices — only a
 * manual allocation reduces it. Money once allocated to an invoice that is
 * later CANCELLED falls back into the advance, so it is never lost.
 */
export function paymentAdvanceOf(payment: {
  amount: Prisma.Decimal;
  status: PaymentStatus;
  allocations: { amount: Prisma.Decimal; invoice: { status: InvoiceStatus } }[];
}): Prisma.Decimal {
  if (payment.status !== PaymentStatus.POSTED) return new Prisma.Decimal(0);
  const applied = payment.allocations
    .filter((a) => a.invoice.status !== InvoiceStatus.CANCELLED)
    .reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
  return payment.amount.minus(applied);
}

/**
 * ADR-029: a payment's ledger/accounting date. Direct (cashier/office)
 * payments post at insert (createdAt); an accepted agent handover posts when
 * the cashier accepts it (handoverAt). Every period filter on POSTED money
 * (1C export, dashboards, reversal guards) uses this one rule.
 */
export function paymentPostedAt(payment: { createdAt: Date; handoverAt: Date | null }): Date {
  return payment.handoverAt ?? payment.createdAt;
}

/** Prisma form of `coalesce("handoverAt", "createdAt") BETWEEN from AND to` (either bound optional). */
export function paymentPostedWithin(range: { gte?: Date; lte?: Date }): Prisma.PaymentWhereInput {
  return { OR: [{ handoverAt: range }, { handoverAt: null, createdAt: range }] };
}
