import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type ReconciliationKind = 'STOCK' | 'BALANCE';
export type ReconciliationFindingStatus = 'OPEN' | 'FIXED';

// Mirrors ReconciliationRun / ReconciliationFinding in packages/database/prisma/schema.prisma.
// Decimals arrive as strings; the list endpoints return raw rows (ids only, no names).
export interface ReconciliationRun {
  id: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  triggeredById: string | null;
  startedAt: string;
  finishedAt: string | null;
  stockChecked: number;
  stockFindings: number;
  balanceChecked: number;
  balanceFindings: number;
}

export interface ReconciliationFinding {
  id: string;
  runId: string;
  lastRunId: string;
  kind: ReconciliationKind;
  status: ReconciliationFindingStatus;
  productId: string | null;
  warehouseId: string | null;
  customerId: string | null;
  expectedOnHand: string | null;
  actualOnHand: string | null;
  diffOnHand: string | null;
  expectedReserved: string | null;
  actualReserved: string | null;
  diffReserved: string | null;
  expectedBalance: string | null;
  actualBalance: string | null;
  diffBalance: string | null;
  fixedAt: string | null;
  createdAt: string;
}

export interface DetectResult {
  runId: string;
  stockChecked: number;
  stockFindings: number;
  balanceChecked: number;
  balanceFindings: number;
  selfHealed: number;
}

export interface FixResult {
  finding: ReconciliationFinding;
  outcome: 'FIXED' | 'ALREADY_CONSISTENT';
}

export interface ListFindingsParams {
  page?: number;
  pageSize?: number;
  status?: ReconciliationFindingStatus;
  kind?: ReconciliationKind;
  [key: string]: string | number | undefined;
}

export function useReconciliationRunsQuery(params: { page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: ['reconciliation', 'runs', params],
    queryFn: () => apiFetch<PaginatedResult<ReconciliationRun>>(`/reconciliation/runs${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function useReconciliationFindingsQuery(params: ListFindingsParams) {
  return useQuery({
    queryKey: ['reconciliation', 'findings', params],
    queryFn: () => apiFetch<PaginatedResult<ReconciliationFinding>>(`/reconciliation/findings${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function useRunReconciliationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey }: { idempotencyKey: string }) =>
      apiFetch<DetectResult>('/reconciliation/run', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reconciliation'] }),
  });
}

export function useFixFindingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      apiFetch<FixResult>(`/reconciliation/findings/${id}/fix`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reconciliation'] }),
  });
}
