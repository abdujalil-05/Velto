import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

// Mirrors apps/api/src/modules/analytics/dashboard.service.ts#getDashboard
// (9.3). Decimal fields arrive as strings (Prisma.Decimal -> JSON).
export interface DashboardData {
  today: {
    turnover: string;
    turnoverChangePct: number | null;
    orderCount: number;
    orderCountChangePct: number | null;
    collected: string;
    collectedChangePct: number | null;
    overdueDebt: string;
    overdueDebtChangePct: number | null;
  };
  turnoverLast30Days: { date: string; turnover: string }[];
  agentsToday: {
    agentId: string;
    agentName: string;
    plannedVisits: number;
    completedVisits: number;
    orderCount: number;
    turnover: string;
  }[];
  topDebtors: {
    customerId: string;
    customerName: string;
    buckets: { current: string; d1to30: string; d31to60: string; d61to90: string; d90plus: string };
    total: string;
  }[];
}

export function useDashboardQuery(enabled = true) {
  return useQuery({
    queryKey: ['reports', 'dashboard'],
    queryFn: () => apiFetch<DashboardData>('/reports/dashboard'),
    enabled,
  });
}
