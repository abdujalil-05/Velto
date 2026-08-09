import { useQuery } from '@tanstack/react-query';
import { apiDownload, apiFetch } from './client';
import { toQueryString } from './query-string';

export interface DateRangeParams {
  from?: string;
  to?: string;
  [key: string]: string | undefined;
}

interface ReportRange {
  from: string;
  to: string;
}

// Mirrors apps/api/src/modules/analytics/sales-report.service.ts — Decimal
// fields arrive as strings.
export interface SalesReport {
  range: ReportRange;
  summary: { turnover: string; orderCount: number; avgCheck: string };
  byDay: { date: string; turnover: string }[];
  byAgent: { agentId: string; agentName: string; turnover: string; orderCount: number }[];
  topProducts: { productId: string; productName: string; turnover: string }[];
}

export function useSalesReportQuery(params: DateRangeParams, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'sales', params],
    queryFn: () => apiFetch<SalesReport>(`/reports/sales${toQueryString(params)}`),
    enabled,
  });
}

export function downloadSalesReportExcel(params: DateRangeParams): Promise<void> {
  return apiDownload(`/reports/sales/export${toQueryString(params)}`, `sotuv-hisoboti-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// Mirrors apps/api/src/modules/analytics/agent-performance.service.ts.
export interface AgentPerformanceRow {
  agentId: string;
  agentName: string;
  plannedVisits: number;
  completedVisits: number;
  routeCompletionPct: number | null;
  effectiveVisitPct: number | null;
  orderCount: number;
  turnover: string;
  avgCheck: string;
}

export interface AgentPerformanceReport {
  range: ReportRange;
  agents: AgentPerformanceRow[];
}

export function useAgentPerformanceReportQuery(params: DateRangeParams, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'agents', params],
    queryFn: () => apiFetch<AgentPerformanceReport>(`/reports/agents${toQueryString(params)}`),
    enabled,
  });
}

export function downloadAgentPerformanceExcel(params: DateRangeParams): Promise<void> {
  return apiDownload(`/reports/agents/export${toQueryString(params)}`, `agentlar-hisoboti-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// Mirrors apps/api/src/modules/analytics/overview-report.service.ts. Debt
// fields are a live snapshot ("as of now"), not scoped to [from,to].
export interface OverviewReport {
  range: ReportRange;
  turnover: string;
  orderCount: number;
  avgCheck: string;
  activeCustomers: number;
  newCustomers: number;
  totalCustomers: number;
  totalDebt: string;
  overdueDebt: string;
  overdueDebtPct: number | null;
}

export function useOverviewReportQuery(params: DateRangeParams, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'overview', params],
    queryFn: () => apiFetch<OverviewReport>(`/reports/overview${toQueryString(params)}`),
    enabled,
  });
}

export function downloadOverviewReportExcel(params: DateRangeParams): Promise<void> {
  return apiDownload(`/reports/overview/export${toQueryString(params)}`, `umumiy-hisobot-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
