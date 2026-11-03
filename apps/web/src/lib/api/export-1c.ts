import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDownloadWithHash, apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type ExportFormat = 'EXCEL' | 'CSV' | 'XML';
export type ExportJobStatus = 'QUEUED' | 'PROCESSING' | 'GENERATED' | 'FAILED' | 'ACCOUNTING_ACCEPTED' | 'FAILED_REVIEW';
export type AckResult = 'ACCEPTED' | 'REJECTED';

export const ACTIVE_EXPORT_STATUSES: ExportJobStatus[] = ['QUEUED', 'PROCESSING'];
export const DOWNLOADABLE_EXPORT_STATUSES: ExportJobStatus[] = ['GENERATED', 'ACCOUNTING_ACCEPTED', 'FAILED_REVIEW'];

export type UnsupportedReason = 'DISCOUNT' | 'VAT' | 'QTY_X_PRICE_MISMATCH' | 'UNIT' | 'TOTAL_MISMATCH';

export interface UnsupportedViolation {
  invoiceId: string;
  invoiceNumber: string;
  sku: string | null;
  reasons: UnsupportedReason[];
}

export interface ExportErrorLog {
  code?: string;
  message?: string;
  messages?: { uz: string; ru: string; en: string };
  total?: number;
  violations?: UnsupportedViolation[];
  warnings?: string[];
}

export const UNSUPPORTED_COMBINATION_CODE = '1C_EXPORT_UNSUPPORTED_COMBINATION';

export interface ExportJob {
  id: string;
  format: ExportFormat;
  periodFrom: string;
  periodTo: string;
  status: ExportJobStatus;
  errorLog: ExportErrorLog | null;
  fileHash: string | null;
  recordCount: number | null;
  fileName: string | null;
  fileSize: number | null;
  generatedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackChecksum: string | null;
  ackNote: string | null;
  createdAt: string;
}

const KEY = 'export-1c';

export function useExportJobsQuery(params: { page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: [KEY, params],
    queryFn: () => apiFetch<PaginatedResult<ExportJob>>(`/export/1c${toQueryString(params)}`),
    placeholderData: (previous) => previous,
    // Quiet polling while any job is still being generated (no spinner: isFetching is not surfaced).
    refetchInterval: (query) => (query.state.data?.data.some((j) => ACTIVE_EXPORT_STATUSES.includes(j.status)) ? 4000 : false),
  });
}

export interface CreateExportInput {
  from: string;
  to: string;
  format: ExportFormat;
  idempotencyKey: string;
}

export function useCreateExportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: CreateExportInput) =>
      apiFetch<ExportJob>('/export/1c', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

export interface AckExportInput {
  id: string;
  result: AckResult;
  checksum: string;
  note?: string;
  idempotencyKey: string;
}

export function useAckExportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey, ...body }: AckExportInput) =>
      apiFetch<ExportJob>(`/export/1c/${id}/ack`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } }),
    // Also on error: a 409 means the row changed under us, so refetch the truth.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** GET /export/1c/:id/download via the authenticated fetch; resolves with the server-reported SHA-256 (null if not exposed). */
export function useDownloadExportMutation() {
  return useMutation({
    mutationFn: (job: Pick<ExportJob, 'id' | 'fileName'>) => apiDownloadWithHash(`/export/1c/${job.id}/download`, job.fileName ?? `export-${job.id}`),
  });
}
