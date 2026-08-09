import { useQuery } from '@tanstack/react-query';
import { apiDownload, apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

// Mirrors apps/api/src/modules/finance/reports/aging-report.service.ts —
// Decimal fields arrive as strings.
export interface AgingBuckets {
  current: string;
  d1to30: string;
  d31to60: string;
  d61to90: string;
  d90plus: string;
}

export interface AgingRow {
  customerId: string;
  customerName: string;
  buckets: AgingBuckets;
  total: string;
}

export interface AgingReportParams {
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

// `enabled` mirrors the sibling report hooks in ./reports.ts so the reports
// page can gate this on its active tab — without it the aging report was
// fetched on every visit to /reports, including the three tabs that never
// show it.
export function useAgingReportQuery(params: AgingReportParams, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'aging', params],
    queryFn: () => apiFetch<PaginatedResult<AgingRow>>(`/reports/aging${toQueryString(params)}`),
    placeholderData: (previous) => previous,
    enabled,
  });
}

/** Streams the server-generated .xlsx (every indebted customer, not just one page) — not JSON, so it bypasses apiFetch. */
export function downloadAgingReportExcel(): Promise<void> {
  return apiDownload('/reports/aging/export', `qarzdorlik-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
