import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

// M08 Xarid (ADR-011). Money/qty are decimal strings — format only.

export interface Supplier {
  id: string;
  name: string;
  legalName: string | null;
  inn: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  isActive: boolean;
}

export interface SupplierInput {
  name: string;
  legalName?: string;
  inn?: string;
  phone?: string;
  address?: string;
  note?: string;
}

export interface ListSuppliersParams {
  page?: number;
  pageSize?: number;
  search?: string;
  isActive?: boolean;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | boolean | undefined;
}

export type PurchaseOrderStatus = 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  unit: string;
  qty: string;
  qtyReceived: string;
  unitPrice: string;
  vatRate: string;
  lineTotal: string;
}

export interface GoodsReceiptLine {
  id: string;
  purchaseOrderLineId: string | null;
  productId: string;
  productName: string;
  productSku: string;
  unit: string;
  qty: string;
  unitCost: string | null;
}

export interface GoodsReceipt {
  id: string;
  warehouseId: string;
  purchaseOrderId: string | null;
  supplierId: string | null;
  receivedAt: string;
  note: string | null;
  lines: GoodsReceiptLine[];
}

export interface PurchaseOrder {
  id: string;
  number: string;
  supplierId: string;
  warehouseId: string;
  status: PurchaseOrderStatus;
  expectedAt: string | null;
  totalAmount: string;
  note: string | null;
  orderedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  supplier: { id: string; name: string };
  warehouse: { id: string; name: string };
}

export interface PurchaseOrderDetail extends PurchaseOrder {
  lines: PurchaseOrderLine[];
  goodsReceipts: GoodsReceipt[];
}

export interface ListPurchaseOrdersParams {
  page?: number;
  pageSize?: number;
  status?: PurchaseOrderStatus;
  supplierId?: string;
  warehouseId?: string;
  from?: string;
  to?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | undefined;
}

export interface PurchaseOrderInput {
  supplierId: string;
  warehouseId: string;
  status?: 'DRAFT' | 'ORDERED';
  expectedAt?: string;
  note?: string;
  lines: { productId: string; qty: number; unitPrice: number }[];
}

export interface GoodsReceiptInput {
  /** Generated once per open form; a resend must reuse it (idempotency). */
  clientId: string;
  purchaseOrderId?: string;
  warehouseId?: string;
  supplierId?: string;
  note?: string;
  lines: { purchaseOrderLineId?: string; productId?: string; qty: number; unitCost?: number }[];
}

export function useSuppliersQuery(params: ListSuppliersParams, enabled = true) {
  return useQuery({
    queryKey: ['purchases', 'suppliers', params],
    queryFn: () => apiFetch<PaginatedResult<Supplier>>(`/purchases/suppliers${toQueryString(params)}`),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useCreateSupplierMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SupplierInput) => apiFetch<Supplier>('/purchases/suppliers', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchases', 'suppliers'] }),
  });
}

export function useUpdateSupplierMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<SupplierInput>) =>
      apiFetch<Supplier>(`/purchases/suppliers/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchases', 'suppliers'] }),
  });
}

export function useDeactivateSupplierMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<Supplier>(`/purchases/suppliers/${id}/deactivate`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchases', 'suppliers'] }),
  });
}

export function usePurchaseOrdersQuery(params: ListPurchaseOrdersParams) {
  return useQuery({
    queryKey: ['purchases', 'orders', params],
    queryFn: () => apiFetch<PaginatedResult<PurchaseOrder>>(`/purchases/orders${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function usePurchaseOrderQuery(id: string) {
  return useQuery({
    queryKey: ['purchases', 'order', id],
    queryFn: () => apiFetch<PurchaseOrderDetail>(`/purchases/orders/${id}`),
    enabled: !!id,
  });
}

export function useCreatePurchaseOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PurchaseOrderInput) =>
      apiFetch<PurchaseOrderDetail>('/purchases/orders', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchases', 'orders'] }),
  });
}

export function useMarkOrderedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<PurchaseOrderDetail>(`/purchases/orders/${id}/order`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchases'] }),
  });
}

export function useCancelPurchaseOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<PurchaseOrderDetail>(`/purchases/orders/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchases'] }),
  });
}

export function useCreateGoodsReceiptMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GoodsReceiptInput) =>
      apiFetch<GoodsReceipt>('/purchases/receipts', { method: 'POST', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchases'] });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
    },
  });
}

export interface GoodsReceiptListItem {
  id: string;
  receivedAt: string;
  note: string | null;
  lineCount: number;
  totalQty: string;
  warehouse: { id: string; name: string };
  supplier: { id: string; name: string } | null;
  purchaseOrder: { id: string; number: string } | null;
  receivedBy: { id: string; firstName: string; lastName: string } | null;
}

export interface ListReceiptsParams {
  page?: number;
  pageSize?: number;
  sortBy?: 'receivedAt';
  dir?: 'asc' | 'desc';
  supplierId?: string;
  warehouseId?: string;
  purchaseOrderId?: string;
  from?: string;
  to?: string;
  [key: string]: string | number | undefined;
}

export function useReceiptsQuery(params: ListReceiptsParams, enabled = true) {
  return useQuery({
    queryKey: ['purchases', 'receipts', params],
    queryFn: () => apiFetch<PaginatedResult<GoodsReceiptListItem>>(`/purchases/receipts${toQueryString(params)}`),
    placeholderData: (previous) => previous,
    enabled,
  });
}
