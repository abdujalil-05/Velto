import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';
import type { ImportRowError, ImportRowMessage } from './imports';

// Mirrors apps/api/src/modules/opening-balances (ADR-041..043).
export type OpeningKind = 'CUSTOMER_BALANCE' | 'STOCK';
export type OpeningStatus = 'PREVIEWED' | 'POSTED' | 'VOIDED';

export interface OpeningBatch {
  id: string;
  kind: OpeningKind;
  /** YYYY-MM-DD (ISO datetime from the API; date part is the company day). */
  asOfDate: string;
  source: string;
  status: OpeningStatus;
  rowCount: number;
  /** Decimal strings. */
  debtTotal: string;
  creditTotal: string;
  qtyTotal: string;
  postedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

export interface OpeningWarning {
  code: string;
  message: ImportRowMessage;
  batchIds: string[];
}

export interface OpeningReportSummary {
  batch: OpeningBatch;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errors: ImportRowError[];
  warnings: OpeningWarning[];
}

export interface PostOpeningInput {
  asOfDate: string;
  source: string;
  controlDebt: string;
  controlCredit: string;
  controlQty: string;
  signOff: boolean;
}

export interface ListOpeningParams {
  page?: number;
  pageSize?: number;
  kind?: OpeningKind;
  status?: OpeningStatus;
  [key: string]: string | number | undefined;
}

const PREVIEW_PATH: Record<OpeningKind, string> = {
  CUSTOMER_BALANCE: '/opening-balances/customers/preview',
  STOCK: '/opening-balances/stock/preview',
};

export function useOpeningBatchesQuery(params: ListOpeningParams, enabled = true) {
  return useQuery({
    queryKey: ['opening-balances', params],
    queryFn: () => apiFetch<PaginatedResult<OpeningBatch>>(`/opening-balances${toQueryString(params)}`),
    placeholderData: (previous) => previous,
    enabled,
  });
}

export function useOpeningBatchQuery(id: string | null) {
  return useQuery({
    queryKey: ['opening-balances', id],
    queryFn: () => apiFetch<OpeningReportSummary>(`/opening-balances/${id}`),
    enabled: !!id,
  });
}

export function usePreviewOpeningMutation(kind: OpeningKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return apiFetch<OpeningReportSummary>(PREVIEW_PATH[kind], { method: 'POST', body: form });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['opening-balances'] }),
  });
}

/** Posting changes balances, stock and the receivables ledger — refresh every dependent cache. */
function invalidateLedger(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ['opening-balances', 'customers', 'invoices', 'payments', 'stock', 'receivables', 'reports', 'dashboard']) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

export function usePostOpeningMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input, idempotencyKey }: { id: string; input: PostOpeningInput; idempotencyKey: string }) =>
      apiFetch<OpeningBatch>(`/opening-balances/${id}/post`, {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => invalidateLedger(queryClient),
  });
}

export function useVoidOpeningMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, idempotencyKey }: { id: string; reason: string; idempotencyKey: string }) =>
      apiFetch<OpeningBatch>(`/opening-balances/${id}/void`, {
        method: 'POST',
        body: { reason },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => invalidateLedger(queryClient),
  });
}
