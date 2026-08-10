import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  isActive: boolean;
}

export interface ListSuppliersParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | undefined;
}

export function useSuppliersQuery(params: ListSuppliersParams, enabled = true) {
  return useQuery({
    queryKey: ['suppliers', params],
    queryFn: () => apiFetch<PaginatedResult<Supplier>>(`/suppliers${toQueryString(params)}`),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useSupplierQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: ['suppliers', id],
    queryFn: () => apiFetch<Supplier>(`/suppliers/${id}`),
    enabled: enabled && !!id,
  });
}

export interface SupplierInput {
  name: string;
  phone?: string;
  address?: string;
}

export function useCreateSupplierMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SupplierInput) => apiFetch<Supplier>('/suppliers', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suppliers'] }),
  });
}

export function useUpdateSupplierMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<SupplierInput> & { isActive?: boolean }) =>
      apiFetch<Supplier>(`/suppliers/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suppliers'] }),
  });
}

export function useDeleteSupplierMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/suppliers/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suppliers'] }),
  });
}

/** Reactivate — takes the id at call time, for use from a table row rather than a fixed-id form. */
export function useActivateSupplierMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<Supplier>(`/suppliers/${id}`, { method: 'PATCH', body: { isActive: true } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suppliers'] }),
  });
}

// --- Telegram link (supplier order notifications) ---

/** One-time code the supplier feeds to the bot's `/start`. `deepLink` is null when the API has no TELEGRAM_BOT_USERNAME configured. */
export interface SupplierTelegramCode {
  code: string;
  expiresAt: string;
  deepLink: string | null;
}

export interface SupplierTelegramStatus {
  linked: boolean;
  telegramId: string | null;
  username: string | null;
  linkedAt: string | null;
  pendingCode: SupplierTelegramCode | null;
}

/** Key is nested under the supplier so a `['suppliers']` invalidation refreshes link state too. */
function telegramKey(supplierId: string) {
  return ['suppliers', supplierId, 'telegram'] as const;
}

export function useSupplierTelegramQuery(supplierId: string, enabled = true) {
  return useQuery({
    queryKey: telegramKey(supplierId),
    queryFn: () => apiFetch<SupplierTelegramStatus>(`/suppliers/${supplierId}/telegram`),
    enabled: enabled && !!supplierId,
  });
}

/** POST takes no request body — the server derives everything from the supplier id and the caller. */
export function useIssueSupplierTelegramCodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (supplierId: string) =>
      apiFetch<SupplierTelegramCode>(`/suppliers/${supplierId}/telegram/link-code`, { method: 'POST' }),
    onSuccess: (_data, supplierId) => queryClient.invalidateQueries({ queryKey: telegramKey(supplierId) }),
  });
}

export function useUnlinkSupplierTelegramMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (supplierId: string) =>
      apiFetch<SupplierTelegramStatus>(`/suppliers/${supplierId}/telegram`, { method: 'DELETE' }),
    onSuccess: (_data, supplierId) => queryClient.invalidateQueries({ queryKey: telegramKey(supplierId) }),
  });
}
