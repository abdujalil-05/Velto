import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export interface CashSession {
  id: string;
  userId: string;
  user?: { id: string; firstName: string; lastName: string };
  openedAt: string;
  closedAt: string | null;
  openAmount: string;
  closeAmount: string | null;
  totalCollected: string;
}

export interface ListCashSessionsParams {
  page?: number;
  pageSize?: number;
  userId?: string;
  [key: string]: string | number | undefined;
}

export function useCashSessionsQuery(params: ListCashSessionsParams) {
  return useQuery({
    queryKey: ['cash-sessions', params],
    queryFn: () => apiFetch<PaginatedResult<CashSession>>(`/cash-sessions${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

/** `null` means "no open shift" (backend's CASH_SESSION_NOT_OPEN, 9.2's normal starting state) — not an error. */
export function useCurrentCashSessionQuery() {
  return useQuery({
    queryKey: ['cash-sessions', 'current'],
    queryFn: async (): Promise<CashSession | null> => {
      try {
        return await apiFetch<CashSession>('/cash-sessions/current');
      } catch (error) {
        if (error instanceof ApiError && error.code === 'CASH_SESSION_NOT_OPEN') return null;
        throw error;
      }
    },
  });
}

export function useOpenCashSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (openAmount: number) => apiFetch<CashSession>('/cash-sessions/open', { method: 'POST', body: { openAmount } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cash-sessions'] }),
  });
}

export function useCloseCashSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, closeAmount }: { id: string; closeAmount: number }) =>
      apiFetch<CashSession>(`/cash-sessions/${id}/close`, { method: 'POST', body: { closeAmount } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cash-sessions'] }),
  });
}
