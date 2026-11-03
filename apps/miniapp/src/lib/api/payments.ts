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

export interface CreatePaymentInput {
  customerId: string;
  /** Decimal string, ≤2dp (ADR-059) - never a JS float. */
  amount: string;
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

export interface PaymentStatusRow {
  id: string;
  clientId: string | null;
  status: PaymentStatus;
  handoverAt: string | null;
  handoverRejectReason: string | null;
}

/** Server cap per POST /payments/statuses call (ids + clientIds combined, else 400 PAYMENT_STATUSES_LIMIT). */
export const PAYMENT_STATUSES_LIMIT = 100;

/** Cashier decisions for my own payments by server id and/or clientId (<= 100 in total per call). */
export function fetchPaymentStatuses(body: { ids?: string[]; clientIds?: string[] }): Promise<PaymentStatusRow[]> {
  return apiFetch<PaymentStatusRow[]>('/payments/statuses', { method: 'POST', body });
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

export type ReconciliationStatus = 'OPEN' | 'EXISTING_PAYMENT_CONFIRMED' | 'NOT_POSTED_CONFIRMED' | 'UNKNOWN';

export interface ReconciliationStatusItem {
  clientId: string;
  status: ReconciliationStatus;
  resolvedAt?: string;
}

/** POST /payments/reconciliations/status - the server (not the client) decides whether a held payment is resolved. ≤100 ids. */
export function fetchReconciliationStatus(clientIds: string[], signal?: AbortSignal): Promise<{ items: ReconciliationStatusItem[] }> {
  return apiFetch<{ items: ReconciliationStatusItem[] }>('/payments/reconciliations/status', { method: 'POST', body: { clientIds }, signal });
}
