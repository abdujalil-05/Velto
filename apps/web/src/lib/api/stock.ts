import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export interface StockLevelRow {
  productId: string;
  warehouseId: string;
  onHand: string;
  reserved: string;
  available: string;
  product: { id: string; sku: string; name: string; baseUnit: string };
  warehouse: { id: string; name: string };
}

export interface ListStockParams {
  page?: number;
  pageSize?: number;
  warehouseId?: string;
  productId?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | undefined;
}

export function useStockLevelsQuery(params: ListStockParams) {
  return useQuery({
    queryKey: ['stock', params],
    queryFn: () => apiFetch<PaginatedResult<StockLevelRow>>(`/stock${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

/** Single-row lookup for the "available" hint next to an order line's qty input. */
export function useStockAvailabilityQuery(productId: string | null, warehouseId: string | null) {
  return useQuery({
    queryKey: ['stock', 'availability', productId, warehouseId],
    queryFn: () =>
      apiFetch<PaginatedResult<StockLevelRow>>(`/stock${toQueryString({ productId: productId!, warehouseId: warehouseId!, pageSize: 1 })}`),
    enabled: !!productId && !!warehouseId,
    select: (result) => result.data[0]?.available,
  });
}

export interface ReceiveStockInput {
  productId: string;
  warehouseId: string;
  qty: number;
  note?: string;
}

export function useReceiveStockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReceiveStockInput) => apiFetch<StockLevelRow>('/stock/receive', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['stock'] }),
  });
}

/** POST /stock/movements/:id/reverse — manual RECEIVE/ADJUST movements only (needs `stock.reverse`). */
export function useReverseStockMovementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, idempotencyKey }: { id: string; reason: string; idempotencyKey: string }) =>
      apiFetch<unknown>(`/stock/movements/${id}/reverse`, {
        method: 'POST',
        body: { reason },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['stock'] }),
  });
}
