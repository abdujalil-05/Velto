import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDownload, apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type ImportType = 'customers' | 'products';
export type ImportStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

export interface ImportRowError {
  row: number;
  messages: string[];
}

export interface ImportErrorLog {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errors: ImportRowError[];
  rows?: unknown[];
  createdCount?: number;
  skippedCount?: number;
  message?: string;
}

export interface ImportJob {
  id: string;
  companyId: string;
  type: ImportType;
  status: ImportStatus;
  fileUrl: string;
  errorLog: ImportErrorLog | null;
  createdAt: string;
}

export interface ListImportsParams {
  type?: ImportType;
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

export function useImportJobsQuery(params: ListImportsParams) {
  return useQuery({
    queryKey: ['imports', params],
    queryFn: () => apiFetch<PaginatedResult<ImportJob>>(`/import${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function useImportJobQuery(id: string | null, poll: boolean) {
  return useQuery({
    queryKey: ['imports', id],
    queryFn: () => apiFetch<ImportJob>(`/import/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      if (!poll) return false;
      const status = query.state.data?.status;
      return status === 'PROCESSING' ? 1500 : false;
    },
  });
}

export function useUploadImportMutation(type: ImportType) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return apiFetch<ImportJob>(`/import/${type}`, { method: 'POST', body: form });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['imports'] }),
  });
}

export function useConfirmImportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<ImportJob>(`/import/${id}/confirm`, { method: 'POST' }),
    onSuccess: (job, id) => {
      queryClient.invalidateQueries({ queryKey: ['imports'] });
      queryClient.invalidateQueries({ queryKey: ['imports', id] });
      // The confirm step actually inserts the rows (import.processor.ts), so
      // the imported resource's own cache is now stale.
      if (job.type === 'customers') {
        queryClient.invalidateQueries({ queryKey: ['customers'] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['products'] });
        queryClient.invalidateQueries({ queryKey: ['categories'] });
      }
    },
  });
}

/** Streams the .xlsx template — not JSON, so it bypasses apiFetch. */
export function downloadImportTemplate(type: ImportType): Promise<void> {
  return apiDownload(`/import/${type}/template`, `${type}-template.xlsx`);
}
