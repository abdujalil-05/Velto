import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDownloadWithHash, apiFetch } from './client';
import { toQueryString } from './query-string';
import { ACTIVE_EXPORT_STATUSES, type ExportJob } from './export-1c';
import type { PaginatedResult } from './types';

const KEY = 'company-export';

/** ADR-045: OWNER-only (`company.export`). Same ExportJob view as the 1C export. */
export function useCompanyExportsQuery(params: { page?: number; pageSize?: number }, enabled = true) {
  return useQuery({
    queryKey: [KEY, params],
    enabled,
    queryFn: () => apiFetch<PaginatedResult<ExportJob>>(`/company-export${toQueryString(params)}`),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => (query.state.data?.data.some((j) => ACTIVE_EXPORT_STATUSES.includes(j.status)) ? 4000 : false),
  });
}

export function useCreateCompanyExportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (idempotencyKey: string) => apiFetch<ExportJob>('/company-export', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
    // Also on error: a 409 means a job is already active, so show it.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDownloadCompanyExportMutation() {
  return useMutation({
    mutationFn: (job: Pick<ExportJob, 'id' | 'fileName'>) => apiDownloadWithHash(`/company-export/${job.id}/download`, job.fileName ?? `company-export-${job.id}.xlsx`),
  });
}
