import { useQuery } from '@tanstack/react-query';
import { apiDownload, apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

// Mirrors apps/api/src/modules/finance/reports/aging-report.service.ts —
// Decimal fields arrive as strings.
export interface AgingBuckets {
  current: string;
  d1to7: string;
  d8to30: string;
  d31to60: string;
  d60plus: string;
}

export type AgingReport = PaginatedResult<AgingRow> & { asOf: string; timeZone: string };

/** Today's calendar date (YYYY-MM-DD) in Asia/Tashkent — the report's default `asOf` (TZ §6.5). */
export function tashkentToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
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
  asOf?: string;
  [key: string]: string | number | undefined;
}

// `enabled` mirrors the sibling report hooks in ./reports.ts so the reports
// page can gate this on its active tab — without it the aging report was
// fetched on every visit to /reports, including the three tabs that never
// show it.
export function useAgingReportQuery(params: AgingReportParams, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'aging', params],
    queryFn: () => apiFetch<AgingReport>(`/reports/aging${toQueryString(params)}`),
    placeholderData: (previous) => previous,
    enabled,
  });
}

/** Streams the server-generated .xlsx (every indebted customer, not just one page) — not JSON, so it bypasses apiFetch. */
export function downloadAgingReport(asOf: string, format: 'xlsx' | 'csv'): Promise<void> {
  const path = format === 'csv' ? '/reports/aging/export.csv' : '/reports/aging/export';
  return apiDownload(`${path}${toQueryString({ asOf })}`, `qarzdorlik-${asOf}.${format}`);
}
