import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

import type { GpsStatus, VisitGpsFields } from '@/lib/gps-payload';

export type VisitOutcome = 'ORDERED' | 'NO_ORDER' | 'SKIPPED';

/** GPS fields are optional; gpsOk/gpsStatus are server-derived and must never be sent. */
export interface CreateVisitInput extends VisitGpsFields {
  outletId: string;
  startedAt: string;
  endedAt?: string;
  outcome: VisitOutcome;
  noOrderReason?: string;
  /** Required (non-blank) when outcome === 'SKIPPED'. */
  skipReason?: string;
  clientId: string;
}

export interface Visit {
  id: string;
  outletId: string;
  agentId: string;
  gpsOk: boolean | null;
  gpsStatus?: GpsStatus;
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
