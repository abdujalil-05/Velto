import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type OrderStatus = 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CLOSED' | 'CANCELLED';

export interface OrderLine {
  id: string;
  productId: string;
  packagingId: string;
  qty: string;
  unitPrice: string;
  discountPct: string;
  lineTotal: string;
  product: { id: string; name: string; sku: string };
  packaging: { id: string; name: string; qtyInBaseUnit: string };
}

export interface Order {
  id: string;
  number: string;
  customerId: string;
  outletId: string | null;
  agentId: string | null;
  status: OrderStatus;
  createdAt: string;
  lines: OrderLine[];
  total: string;
}

export interface ListOrdersParams {
  page?: number;
  pageSize?: number;
  customerId?: string;
  agentId?: string;
  status?: OrderStatus;
  from?: string;
  to?: string;
  [key: string]: string | number | undefined;
}

export function useOrdersQuery(params: ListOrdersParams, enabled = true) {
  return useQuery({
    queryKey: ['orders', params],
    queryFn: () => apiFetch<PaginatedResult<Order>>(`/orders${toQueryString(params)}`),
    enabled,
  });
}

/** 9.4 Ekran 1/4: the customer's most recent order, source for the "repeat last order" shortcut. */
export function useLastOrderQuery(customerId: string | null) {
  return useQuery({
    queryKey: ['orders', 'last', customerId],
    queryFn: () => apiFetch<PaginatedResult<Order>>(`/orders${toQueryString({ customerId: customerId!, pageSize: 1 })}`),
    enabled: !!customerId,
    select: (result) => result.data[0] ?? null,
  });
}

export interface CreateOrderLineInput {
  productId: string;
  packagingId: string;
  qty: number;
  discountPct?: number;
}

export interface CreateOrderInput {
  customerId: string;
  outletId?: string;
  note?: string;
  clientId: string;
  lines: CreateOrderLineInput[];
}

export function useCreateOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrderInput) => apiFetch<Order>('/orders', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
}
