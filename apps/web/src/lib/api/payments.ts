import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

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
    },
  });
}
