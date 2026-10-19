import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

export type PaymentSource = 'COLLECTION' | 'OPENING';

export type PaymentStatus = 'PENDING_HANDOVER' | 'POSTED' | 'REJECTED' | 'REVERSED';

export interface PaymentAllocation {
  id: string;
  invoiceId: string;
  amount: string;
  invoice: { id: string; number: string; total: string };
}

export interface Payment {
  id: string;
  number: string;
  customerId: string;
  customer: { id: string; name: string; code: string };
  amount: string;
  method: PaymentMethod;
  status: PaymentStatus;
  /** OPENING = carried-over opening credit (ADR-041), not money collected. */
  source: PaymentSource;
  /** Unallocated POSTED amount (Decimal string). */
  advance: string;
  createdAt: string;
  allocations: PaymentAllocation[];
  handoverActorId?: string | null;
  handoverAt?: string | null;
  handoverCashSessionId?: string | null;
  handoverRejectReason?: string | null;
}

export interface ListPaymentsParams {
  page?: number;
  pageSize?: number;
  customerId?: string;
  status?: PaymentStatus;
  /** Omitted => both sources when no period is given. */
  source?: PaymentSource;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | undefined;
}

export function usePaymentsQuery(params: ListPaymentsParams) {
  return useQuery({
    queryKey: ['payments', params],
    queryFn: () => apiFetch<PaginatedResult<Payment>>(`/payments${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export interface CreatePaymentAllocationInput {
  invoiceId: string;
  amount: number;
}

export interface CreatePaymentInput {
  customerId: string;
  amount: number;
  method: PaymentMethod;
  allocations?: CreatePaymentAllocationInput[];
}

export function useCreatePaymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentInput) => apiFetch<Payment>('/payments', { method: 'POST', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      // payments.service.ts rewrites customer.cachedBalance, and the open cash
      // shift's totalCollected is summed from payments (cash-sessions.service.ts)
      // — both are rendered right next to the payments list on /cash.
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['cash-sessions'] });
    },
  });
}

export function useReversePaymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, idempotencyKey }: { id: string; reason: string; idempotencyKey: string }) =>
      apiFetch<Payment>(`/payments/${id}/reverse`, {
        method: 'POST',
        body: { reason },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['cash-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export interface AllocatePaymentInput {
  id: string;
  allocations: { invoiceId: string; amount: string }[];
  idempotencyKey: string;
}

/** POST /payments/:id/allocate — distributes a payment's advance over open invoices (needs `payments.allocate`). */
export function useAllocatePaymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, allocations, idempotencyKey }: AllocatePaymentInput) =>
      apiFetch<Payment>(`/payments/${id}/allocate`, {
        method: 'POST',
        body: { allocations },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['receivables'] });
    },
  });
}

export interface InTransitSummary {
  customerId: string;
  amount: string;
  count: number;
}

/** GET /payments/in-transit — money handed to an agent/courier but not yet accepted by a cashier (balance not reduced). */
export function useInTransitQuery(customerId: string, enabled = true) {
  return useQuery({
    queryKey: ['payments', 'in-transit', customerId],
    queryFn: () => apiFetch<InTransitSummary>(`/payments/in-transit${toQueryString({ customerId })}`),
    enabled: enabled && !!customerId,
  });
}

function invalidateAfterHandover(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ['payments', 'invoices', 'customers', 'cash-sessions', 'receivables', 'reports']) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** POST /payments/:id/handover/accept (needs `payments.handover`; requires an open cash session). */
export function useAcceptHandoverMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      apiFetch<Payment>(`/payments/${id}/handover/accept`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => invalidateAfterHandover(queryClient),
  });
}

/** POST /payments/:id/handover/reject (needs `payments.handover`; reason 3-500). */
export function useRejectHandoverMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, idempotencyKey }: { id: string; reason: string; idempotencyKey: string }) =>
      apiFetch<Payment>(`/payments/${id}/handover/reject`, {
        method: 'POST',
        body: { reason },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => invalidateAfterHandover(queryClient),
  });
}
