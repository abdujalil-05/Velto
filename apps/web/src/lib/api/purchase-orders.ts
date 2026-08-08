import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type PurchaseOrderStatus = 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  qty: string;
  qtyReceived: string;
  unitPrice: string;
  product: { id: string; sku: string; name: string; baseUnit: string };
}

export interface PurchaseOrder {
  id: string;
  number: string;
  supplierId: string;
  warehouseId: string;
  status: PurchaseOrderStatus;
  note: string | null;
  createdAt: string;
  supplier: { id: string; name: string };
  warehouse: { id: string; name: string };
  lines: PurchaseOrderLine[];
}

export interface ListPurchaseOrdersParams {
  page?: number;
  pageSize?: number;
  supplierId?: string;
  status?: PurchaseOrderStatus;
  [key: string]: string | number | undefined;
}

export function usePurchaseOrdersQuery(params: ListPurchaseOrdersParams) {
  return useQuery({
    queryKey: ['purchase-orders', params],
    queryFn: () => apiFetch<PaginatedResult<PurchaseOrder>>(`/purchases${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function usePurchaseOrderQuery(id: string) {
  return useQuery({
    queryKey: ['purchase-orders', id],
    queryFn: () => apiFetch<PurchaseOrder>(`/purchases/${id}`),
    enabled: !!id,
  });
}

export interface CreatePurchaseOrderLineInput {
  productId: string;
  qty: number;
  unitPrice: number;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  warehouseId: string;
  note?: string;
  lines: CreatePurchaseOrderLineInput[];
}

function invalidatePurchaseOrder(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
  queryClient.invalidateQueries({ queryKey: ['purchase-orders', id] });
}

export function useCreatePurchaseOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePurchaseOrderInput) => apiFetch<PurchaseOrder>('/purchases', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchase-orders'] }),
  });
}

export function useSubmitPurchaseOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<PurchaseOrder>(`/purchases/${id}/submit`, { method: 'POST' }),
    onSuccess: () => invalidatePurchaseOrder(queryClient, id),
  });
}

export interface ReceivePurchaseOrderLineInput {
  purchaseOrderLineId: string;
  qty: number;
}

export function useReceivePurchaseOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lines: ReceivePurchaseOrderLineInput[]) =>
      apiFetch<PurchaseOrder>(`/purchases/${id}/receive`, { method: 'POST', body: { lines } }),
    onSuccess: () => {
      invalidatePurchaseOrder(queryClient, id);
      queryClient.invalidateQueries({ queryKey: ['stock'] });
    },
  });
}

export function useCancelPurchaseOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<PurchaseOrder>(`/purchases/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => invalidatePurchaseOrder(queryClient, id),
  });
}
