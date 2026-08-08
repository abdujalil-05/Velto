import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type InvoiceStatus = 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';

export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  orderId: string | null;
  total: string;
  status: InvoiceStatus;
  createdAt: string;
  paid: string;
  outstanding: string;
}

export interface ListInvoicesParams {
  page?: number;
  pageSize?: number;
  customerId?: string;
  status?: InvoiceStatus;
  [key: string]: string | number | undefined;
}

export function useInvoicesQuery(params: ListInvoicesParams, enabled = true) {
  return useQuery({
    queryKey: ['invoices', params],
    queryFn: () => apiFetch<PaginatedResult<Invoice>>(`/invoices${toQueryString(params)}`),
    enabled,
  });
}
