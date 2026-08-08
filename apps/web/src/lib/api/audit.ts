import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

// Mirrors apps/api/src/modules/audit/audit.service.ts (AUDIT_LOG_INCLUDE).
export interface AuditLogEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  oldValue: unknown;
  newValue: unknown;
  ip: string | null;
  createdAt: string;
  user: { id: string; firstName: string; lastName: string } | null;
}

export interface ListAuditLogParams {
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

export function useAuditLogQuery(params: ListAuditLogParams) {
  return useQuery({
    queryKey: ['audit', params],
    queryFn: () => apiFetch<PaginatedResult<AuditLogEntry>>(`/audit${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}
