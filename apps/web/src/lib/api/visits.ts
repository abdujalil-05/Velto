import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export const GPS_STATUSES = ['VERIFIED', 'OUTSIDE_RADIUS', 'LOW_ACCURACY', 'NO_PERMISSION', 'NO_FIX', 'OUTLET_NO_COORDS'] as const;
export type GpsStatus = (typeof GPS_STATUSES)[number];
export type VisitOutcome = 'ORDERED' | 'NO_ORDER' | 'SKIPPED';

// Mirrors apps/api/src/modules/field/visits (Visit model + VISIT_INCLUDE). Decimals arrive as strings.
export interface Visit {
  id: string;
  agentId: string;
  outletId: string;
  startedAt: string;
  endedAt: string | null;
  gpsStatus: GpsStatus;
  gpsAccuracyM: string | null;
  distanceM: string | null;
  outcome: VisitOutcome;
  noOrderReason: string | null;
  skipReason: string | null;
  outlet: { id: string; name: string; customerId: string };
  agent: { id: string; firstName: string; lastName: string };
}

export interface ListVisitsParams {
  page?: number;
  pageSize?: number;
  agentId?: string;
  gpsStatus?: GpsStatus;
  from?: string;
  to?: string;
  [key: string]: string | number | undefined;
}

export function useVisitsQuery(params: ListVisitsParams, enabled = true) {
  return useQuery({
    queryKey: ['visits', params],
    queryFn: () => apiFetch<PaginatedResult<Visit>>(`/visits${toQueryString(params)}`),
    placeholderData: (previous) => previous,
    enabled,
  });
}
