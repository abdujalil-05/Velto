import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

export interface Payment {
  id: string;
  number: string;
  customerId: string;
  customer: { id: string; name: string; code: string };
  amount: string;
  method: PaymentMethod;
  createdAt: string;
  allocations: { id: string; invoiceId: string; amount: string; invoice: { number: string } }[];
}

export interface ListPaymentsParams {
  page?: number;
  pageSize?: number;
  collectedBy?: string;
  from?: string;
  to?: string;
  [key: string]: string | number | undefined;
}

/** Home screen (9.4 Ekran 1, "Yig'ilgan: ...") — payments *I* collected today. */
export function usePaymentsQuery(params: ListPaymentsParams, enabled = true) {
  return useQuery({
    queryKey: ['payments', params],
    queryFn: () => apiFetch<PaginatedResult<Payment>>(`/payments${toQueryString(params)}`),
    enabled,
  });
}

export interface CreatePaymentInput {
  customerId: string;
  amount: number;
  method: PaymentMethod;
  clientId: string;
}

/** 8.4/9.4: `allocations` omitted → server auto-FIFOs across the customer's oldest open invoices. */
export function useCreatePaymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentInput) => apiFetch<Payment>('/payments', { method: 'POST', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
