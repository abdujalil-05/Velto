import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { Product, ProductPackaging } from './products';
import type { PaginatedResult } from './types';
import type { OrderStatus } from './customers';

export interface SalesOrderLine {
  id: string;
  productId: string;
  packagingId: string;
  qty: string;
  unitPrice: string;
  discountPct: string;
  vatRate: string;
  lineTotal: string;
  product: Product;
  packaging: ProductPackaging;
}

export interface SalesOrder {
  id: string;
  number: string;
  customerId: string;
  outletId: string | null;
  agentId: string | null;
  warehouseId: string;
  status: OrderStatus;
  note: string | null;
  createdAt: string;
  lines: SalesOrderLine[];
  total: string;
  customer: { id: string; name: string; code: string };
  outlet: { id: string; name: string } | null;
  agent: { id: string; firstName: string; lastName: string } | null;
  warehouse: { id: string; name: string };
}

export interface ListOrdersParams {
  page?: number;
  pageSize?: number;
  status?: OrderStatus;
  customerId?: string;
  agentId?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | undefined;
}

export function useOrdersQuery(params: ListOrdersParams) {
  return useQuery({
    queryKey: ['orders', params],
    queryFn: () => apiFetch<PaginatedResult<SalesOrder>>(`/orders${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function useOrderQuery(id: string) {
  return useQuery({
    queryKey: ['orders', id],
    queryFn: () => apiFetch<SalesOrder>(`/orders/${id}`),
    enabled: !!id,
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
  warehouseId?: string;
  note?: string;
  lines: CreateOrderLineInput[];
}

function invalidateOrder(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  queryClient.invalidateQueries({ queryKey: ['orders'] });
  queryClient.invalidateQueries({ queryKey: ['orders', id] });
}

export function useCreateOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrderInput) => apiFetch<SalesOrder>('/orders', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useConfirmOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SalesOrder>(`/orders/${id}/confirm`, { method: 'POST' }),
    onSuccess: () => invalidateOrder(queryClient, id),
  });
}

export function useDeliverOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SalesOrder>(`/orders/${id}/deliver`, { method: 'POST' }),
    onSuccess: () => invalidateOrder(queryClient, id),
  });
}

export function useCloseOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SalesOrder>(`/orders/${id}/close`, { method: 'POST' }),
    onSuccess: () => invalidateOrder(queryClient, id),
  });
}

export function useCancelOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => apiFetch<SalesOrder>(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => invalidateOrder(queryClient, id),
  });
}
