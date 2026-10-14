import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDownload, apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type ImportType = 'customers' | 'products';
export type ImportStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

export interface ImportRowMessage {
  uz: string;
  ru: string;
  en: string;
}

export interface ImportRowError {
  row: number;
  /** uz text (legacy shape) — fallback when `i18n` is absent. */
  messages: string[];
  /** Same messages, trilingual and parallel to `messages`. */
  i18n?: ImportRowMessage[];
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
  /** 0-100, advanced by the commit worker after each chunk. */
  progress: number;
  createdBy: string | null;
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

/** Poll every 3s, backing off x1.5 up to 15s while the job stays in PROCESSING; stops on any other status (the API throttles). */
const POLL_BASE_MS = 3_000;
const POLL_MAX_MS = 15_000;

export function useImportJobQuery(id: string | null, poll: boolean) {
  return useQuery({
    queryKey: ['imports', id],
    queryFn: () => apiFetch<ImportJob>(`/import/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      if (!poll || query.state.data?.status !== 'PROCESSING') return false;
      return Math.min(POLL_MAX_MS, Math.round(POLL_BASE_MS * 1.5 ** Math.min(query.state.dataUpdateCount, 6)));
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
