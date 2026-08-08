import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { PaginatedResult } from './types';

export interface PriceList {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Distributors run a handful of price lists (6.4) — one page covers the dropdown. */
export function usePriceListsQuery(enabled = true) {
  return useQuery({
    queryKey: ['price-lists'],
    queryFn: () => apiFetch<PaginatedResult<PriceList>>('/price-lists?pageSize=100'),
    enabled,
  });
}

export interface CreatePriceListInput {
  name: string;
  isDefault?: boolean;
}

export function useCreatePriceListMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePriceListInput) => apiFetch<PriceList>('/price-lists', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-lists'] }),
  });
}

export interface PriceListItem {
  id: string;
  productId: string;
  price: string;
}

/**
 * Best-effort unit-price lookup for the order builder's live estimate — the
 * server always recomputes the authoritative total on submit (8.2), this is
 * only a preview. Capped at the max page size (7.1), so a price list beyond
 * 100 SKUs will show "—" for the rest rather than paging through it all.
 */
export function usePriceListItemsQuery(priceListId: string | null) {
  return useQuery({
    queryKey: ['price-lists', priceListId, 'items'],
    queryFn: () => apiFetch<PaginatedResult<PriceListItem>>(`/price-lists/${priceListId}/items?pageSize=100`),
    enabled: !!priceListId,
  });
}

export interface UpsertPriceListItemInput {
  productId: string;
  price: number;
}

/** 9.2 "/price-lists ... jadval ko'rinishida narx tahrirlash" — one bulk save for whichever rows were edited. */
export function useUpsertPriceListItemsMutation(priceListId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: UpsertPriceListItemInput[]) =>
      apiFetch<PaginatedResult<PriceListItem>>(`/price-lists/${priceListId}/items`, { method: 'PUT', body: { items } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-lists', priceListId, 'items'] }),
  });
}
