import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type InvoiceStatus = 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';

export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  total: string;
  outstanding: string;
  status: InvoiceStatus;
  createdAt: string;
}

/** 9.4 Ekran 5: the customer's open invoices, shown before collecting a payment. No server-side "status in [...]" filter exists (list-invoices.query.ts), so OPEN/PARTIALLY_PAID with outstanding > 0 is filtered client-side from the full unpaginated list. */
export function useOpenInvoicesQuery(customerId: string | null) {
  return useQuery({
    queryKey: ['invoices', customerId],
    queryFn: () => apiFetch<PaginatedResult<Invoice>>(`/invoices${toQueryString({ customerId: customerId!, pageSize: 100 })}`),
    enabled: !!customerId,
    select: (result) => result.data.filter((invoice) => Number(invoice.outstanding) > 0),
  });
}
