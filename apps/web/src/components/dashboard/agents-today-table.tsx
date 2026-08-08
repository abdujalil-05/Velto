import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/format';
import type { DashboardData } from '@/lib/api/dashboard';

interface AgentsTodayTableProps {
  agents: DashboardData['agentsToday'];
}

export function AgentsTodayTable({ agents }: AgentsTodayTableProps) {
  const t = useTranslations('Dashboard');
  const tCommon = useTranslations('Common');

  if (agents.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t('noAgentsToday')}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">{t('agent')}</th>
            <th className="pb-2 font-medium">{t('visits')}</th>
            <th className="pb-2 pr-0 text-right font-medium">{t('orders')}</th>
            <th className="pb-2 pl-3 text-right font-medium">{t('turnover')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {agents.map((agent) => (
            <tr key={agent.agentId}>
              <td className="py-2 pr-3">{agent.agentName}</td>
              <td className="py-2 tabular-nums text-muted-foreground">
                {agent.completedVisits}/{agent.plannedVisits}
              </td>
              <td className="py-2 text-right tabular-nums">{agent.orderCount}</td>
              <td className="py-2 pl-3 text-right tabular-nums">
                {formatMoney(agent.turnover)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
