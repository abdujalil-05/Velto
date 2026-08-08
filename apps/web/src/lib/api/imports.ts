import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';
import { getAccessToken } from '@/lib/auth/tokens';

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
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['imports'] });
      queryClient.invalidateQueries({ queryKey: ['imports', id] });
    },
  });
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Streams the .xlsx template — not JSON, so it bypasses apiFetch. */
export async function downloadImportTemplate(type: ImportType): Promise<void> {
  const res = await fetch(`${API_URL}/import/${type}/template`, {
    headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
  });
  if (!res.ok) throw new Error(`Template download failed with status ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const filenameMatch = /filename="?([^"]+)"?/.exec(disposition);
  const filename = filenameMatch?.[1] ?? `${type}-template.xlsx`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
