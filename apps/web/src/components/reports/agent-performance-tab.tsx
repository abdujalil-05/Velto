'use client';

import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/format';
import type { AgentPerformanceReport } from '@/lib/api/reports';

function pct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

export function AgentPerformanceTab({ report }: { report: AgentPerformanceReport }) {
  const t = useTranslations('Reports.agentPerformance');
  const tCommon = useTranslations('Common');

  if (report.agents.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('noData')}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('agent')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('visits')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('routeCompletion')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('effectiveVisits')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('orderCount')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('turnover')}</th>
            <th className="pb-2 text-right font-medium">{t('avgCheck')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {report.agents.map((row) => (
            <tr key={row.agentId} className="hover:bg-accent/50">
              <td className="py-2 pr-3 font-medium">{row.agentName}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {row.completedVisits} / {row.plannedVisits}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{pct(row.routeCompletionPct)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{pct(row.effectiveVisitPct)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{row.orderCount}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatMoney(row.turnover)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
              </td>
              <td className="py-2 text-right tabular-nums">
                {formatMoney(row.avgCheck)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
