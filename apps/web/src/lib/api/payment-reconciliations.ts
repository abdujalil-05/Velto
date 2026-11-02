import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type PaymentReconciliationOutcome = 'EXISTING_PAYMENT_CONFIRMED' | 'NOT_POSTED_CONFIRMED';

// Mirrors GET /payments/reconciliations (OPEN rows). Amount is a decimal string.
export interface PaymentReconciliationItem {
  paymentId: string;
  clientId: string;
  number: string;
  amount: string;
  status: string;
  customerId: string;
  collectedBy: string | null;
  rejectionCount: number;
  lastRejectedAt: string;
}

export interface ConfirmPaymentReconciliationInput {
  clientId: string;
  outcome: PaymentReconciliationOutcome;
  reason: string;
  evidenceRef?: string;
}

export interface ConfirmPaymentReconciliationResult {
  replayed: boolean;
  resolution: { id: string; outcome: PaymentReconciliationOutcome; clientId: string; paymentId: string };
  snapshot: { id: string; number: string; amount: string; status: string; method: string; customerId: string };
}

export function usePaymentReconciliationsQuery(params: { page?: number; pageSize?: number }, enabled = true) {
  return useQuery({
    queryKey: ['payment-reconciliations', params],
    queryFn: () =>
      apiFetch<PaginatedResult<PaymentReconciliationItem>>(`/payments/reconciliations${toQueryString({ ...params, status: 'OPEN' })}`),
    placeholderData: (previous) => previous,
    enabled,
  });
}

export function useConfirmPaymentReconciliationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ConfirmPaymentReconciliationInput) =>
      apiFetch<ConfirmPaymentReconciliationResult>('/payments/reconciliations', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payment-reconciliations'] }),
  });
}
