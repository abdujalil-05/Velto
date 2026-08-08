import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';
import { getAccessToken } from '@/lib/auth/tokens';

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

export function useAgingReportQuery(params: AgingReportParams) {
  return useQuery({
    queryKey: ['reports', 'aging', params],
    queryFn: () => apiFetch<PaginatedResult<AgingRow>>(`/reports/aging${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Streams the server-generated .xlsx (every indebted customer, not just one page) — not JSON, so it bypasses apiFetch. */
export async function downloadAgingReportExcel(): Promise<void> {
  const res = await fetch(`${API_URL}/reports/aging/export`, {
    headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
  });
  if (!res.ok) throw new Error(`Export failed with status ${res.status}`);
  const blob = await res.blob();

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `qarzdorlik-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
