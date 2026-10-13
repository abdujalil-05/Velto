import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

export type PaymentStatus = 'POSTED' | 'REVERSED';

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
  /** Unallocated POSTED amount (Decimal string). */
  advance: string;
  createdAt: string;
  allocations: PaymentAllocation[];
}

export interface ListPaymentsParams {
  page?: number;
  pageSize?: number;
  customerId?: string;
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
