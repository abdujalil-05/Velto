import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

/** ADR-029: agent cash stays PENDING_HANDOVER (no debt reduction) until the cashier accepts (POSTED) or rejects. */
export type PaymentStatus = 'PENDING_HANDOVER' | 'POSTED' | 'REJECTED';

export interface Payment {
  id: string;
  number: string;
  customerId: string;
  customer: { id: string; name: string; code: string };
  amount: string;
  method: PaymentMethod;
  createdAt: string;
  status: PaymentStatus;
  handoverAt: string | null;
  handoverRejectReason: string | null;
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

export interface InTransit {
  amount: string;
  count: number;
}

/** Cash I collected that the cashier has not accepted yet — separate from the customer's debt. Online only. */
export function useInTransitQuery(customerId: string | null) {
  return useQuery({
    queryKey: ['payments', 'in-transit', customerId],
    queryFn: () => apiFetch<InTransit>(`/payments/in-transit${toQueryString({ customerId: customerId ?? undefined })}`),
    enabled: !!customerId,
  });
}
