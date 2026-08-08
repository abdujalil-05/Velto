import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type VisitOutcome = 'ORDERED' | 'NO_ORDER';

export interface CreateVisitInput {
  outletId: string;
  startedAt: string;
  endedAt?: string;
  latitude: number;
  longitude: number;
  outcome: VisitOutcome;
  noOrderReason?: string;
  clientId: string;
}

export interface Visit {
  id: string;
  outletId: string;
  agentId: string;
  gpsOk: boolean | null;
  outcome: VisitOutcome;
  clientId: string | null;
}

export interface ListVisitsParams {
  page?: number;
  pageSize?: number;
  agentId?: string;
  outletId?: string;
  from?: string;
  to?: string;
  [key: string]: string | number | undefined;
}

/** Home screen (9.4 Ekran 1, "8/22 nuqta") and the Route screen's per-stop visited/pending status. */
export function useVisitsQuery(params: ListVisitsParams, enabled = true) {
  return useQuery({
    queryKey: ['visits', params],
    queryFn: () => apiFetch<PaginatedResult<Visit>>(`/visits${toQueryString(params)}`),
    enabled,
  });
}

export function useCreateVisitMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVisitInput) => apiFetch<Visit>('/visits', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['visits'] }),
  });
}
