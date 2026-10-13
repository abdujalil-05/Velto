import { PaymentStatus, type Prisma } from '@velto/database';

/**
 * F2.1 / §6.5 "valid allocations": a PaymentAllocation counts toward an
 * invoice's paid amount / a customer's balance only while its payment is
 * POSTED. A reversed payment keeps its allocation rows (append-only) but they
 * stop counting. Every ledger read must use this one predicate.
 */
export const VALID_ALLOCATION_WHERE = {
  payment: { status: PaymentStatus.POSTED },
} satisfies Prisma.PaymentAllocationWhereInput;
