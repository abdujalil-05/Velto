'use client';

import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useRoutesQuery } from '@/lib/api/routes';
import { formatMoney } from '@/lib/format';
import { Button } from '@/components/ui/button';
import type { User } from '@/lib/api/users';
import type { DashboardData } from '@/lib/api/dashboard';

interface AgentsTableProps {
  agents: User[];
  todayByAgentId: Map<string, DashboardData['agentsToday'][number]>;
  showToday: boolean;
  /** `users.delete`, and never for the currently logged-in user (self-delete is blocked API-side, but hide the affordance too). */
  canDelete?: boolean;
  onDelete?: (agent: User) => void;
  currentUserId?: string;
}

export function AgentsTable({ agents, todayByAgentId, showToday, canDelete = false, onDelete, currentUserId }: AgentsTableProps) {
  const t = useTranslations('Agents');
  const tCommon = useTranslations('Common');
  const showActions = canDelete && !!onDelete;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('name')}</th>
            <th className="pb-2 pr-3 font-medium">{t('phone')}</th>
            <th className="pb-2 pr-3 font-medium">{t('routes')}</th>
            {showToday && (
              <>
                <th className="pb-2 pr-3 text-right font-medium">{t('todayVisits')}</th>
                <th className="pb-2 pr-3 text-right font-medium">{t('todayOrders')}</th>
                <th className="pb-2 text-right font-medium">{t('todayTurnover')}</th>
              </>
            )}
            {showActions && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {agents.map((agent) => {
            const today = todayByAgentId.get(agent.id);
            return (
              <tr key={agent.id} className="hover:bg-accent/50">
                <td className="py-2 pr-3">
                  <Link href={`/users/${agent.id}/edit`} className="font-medium text-primary hover:underline">
                    {agent.firstName} {agent.lastName}
                  </Link>
                </td>
                <td className="py-2 pr-3 text-muted-foreground">{agent.phone}</td>
                <td className="py-2 pr-3">
                  <AgentRouteCount agentId={agent.id} />
                </td>
                {showToday && (
                  <>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {today ? `${today.completedVisits} / ${today.plannedVisits}` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{today ? today.orderCount : '—'}</td>
                    <td className="py-2 text-right tabular-nums">
                      {today ? (
                        <>
                          {formatMoney(today.turnover)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </>
                )}
                {showActions && (
                  <td className="py-2 text-right">
                    {agent.id !== currentUserId && (
                      <Button variant="ghost" size="sm" onClick={() => onDelete?.(agent)} aria-label={t('delete')}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentRouteCount({ agentId }: { agentId: string }) {
  const t = useTranslations('Agents');
  const { data, isLoading } = useRoutesQuery({ agentId, page: 1, pageSize: 1 });

  if (isLoading) return <span className="text-muted-foreground">…</span>;
  const count = data?.meta.total ?? 0;
  return count > 0 ? (
    <Link href={{ pathname: '/routes', query: { agentId } }} className="text-primary hover:underline">
      {t('routeCount', { count })}
    </Link>
  ) : (
    <span className="text-muted-foreground">{t('noRoutes')}</span>
  );
}
