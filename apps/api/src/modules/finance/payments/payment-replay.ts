import { PaymentSource, Prisma, type PaymentMethod } from '@velto/database';
import type { CreatePaymentDto } from '../dto/create-payment.dto';

type AllocationLine = { invoiceId: string; amount: Prisma.Decimal.Value };

/** The payment as originally requested: immutable columns + its create-time MANUAL allocation lines (null = FIFO request). */
export interface StoredPaymentRequest {
  customerId: string;
  amount: Prisma.Decimal;
  method: PaymentMethod | null;
  source: PaymentSource;
  manualAllocations: readonly AllocationLine[] | null;
}

/** Same per-invoice summing as allocateManual: line order and line splitting are not a content difference. */
function byInvoice(lines: readonly AllocationLine[]): Map<string, Prisma.Decimal> {
  const sums = new Map<string, Prisma.Decimal>();
  for (const { invoiceId, amount } of lines) {
    const key = invoiceId.toLowerCase();
    sums.set(key, (sums.get(key) ?? new Prisma.Decimal(0)).plus(amount));
  }
  return sums;
}

/** The provable part: request fields stored on the Payment row itself (customer, amount by Decimal equality, method, COLLECTION source). */
export function isSamePaymentColumns(
  stored: Omit<StoredPaymentRequest, 'manualAllocations'>,
  request: Pick<CreatePaymentDto, 'customerId' | 'amount' | 'method'>,
): boolean {
  if (stored.source !== PaymentSource.COLLECTION || stored.method !== request.method) return false;
  if (stored.customerId.toLowerCase() !== request.customerId.toLowerCase()) return false;
  return stored.amount.equals(new Prisma.Decimal(request.amount));
}

/**
 * 10.4 clientId replay (security audit / PO P0): a resubmitted clientId is an
 * idempotent replay only if every request-supplied essential field matches the
 * original — customer, amount (Decimal equality: "100.00" ≡ 100), method,
 * COLLECTION source and the manual allocation set. Server-mutable state
 * (status, handover fields, timestamps, MANUAL_LATER allocations) is never compared.
 */
export function isSamePaymentRequest(
  stored: StoredPaymentRequest,
  request: Pick<CreatePaymentDto, 'customerId' | 'amount' | 'method' | 'allocations'>,
): boolean {
  if (!isSamePaymentColumns(stored, request)) return false;

  const requested = request.allocations?.length ? request.allocations : null;
  if (!requested || !stored.manualAllocations) return !requested && !stored.manualAllocations;
  const a = byInvoice(requested);
  const b = byInvoice(stored.manualAllocations);
  return a.size === b.size && [...a].every(([invoiceId, amount]) => b.get(invoiceId)?.equals(amount) ?? false);
}
