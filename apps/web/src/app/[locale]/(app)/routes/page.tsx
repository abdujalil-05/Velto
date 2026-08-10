'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Map, Plus, RefreshCw } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useRoutesQuery, type Route } from '@/lib/api/routes';
import { useUsersQuery } from '@/lib/api/users';
import { useCouriersQuery, courierName } from '@/lib/api/couriers';
import { useInitialQueryParam } from '@/lib/hooks/use-initial-query-param';
import { errorMessage } from '@/lib/api/client';
import { exportToCsv } from '@/lib/export-csv';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { RoutesTable } from '@/components/routes/routes-table';
import { cn } from '@/lib/utils';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export default function RoutesPage() {
  const t = useTranslations('Routes');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('routes.create');

  // Deep-linked from the agents/couriers list ("N routes" link) — synced once on mount.
  const initialAgentId = useInitialQueryParam('agentId');
  const initialCourierId = useInitialQueryParam('courierId');
  const [agentId, setAgentId] = useState('');
  const [courierId, setCourierId] = useState('');
  const [weekday, setWeekday] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (initialAgentId) setAgentId(initialAgentId);
  }, [initialAgentId]);
  useEffect(() => {
    if (initialCourierId) setCourierId(initialCourierId);
  }, [initialCourierId]);

  const { data: agents } = useUsersQuery({ roleCode: 'SALES_AGENT', isActive: true, pageSize: 100 });
  const { data: couriers } = useCouriersQuery({ pageSize: 100, isActive: true });
  const { data, isLoading, isError, error, refetch, isFetching } = useRoutesQuery({
    page,
    pageSize: 25,
    agentId: agentId || undefined,
    courierId: courierId || undefined,
    weekday: weekday ? Number(weekday) : undefined,
  });

  const hasFilters = !!agentId || !!courierId || !!weekday;

  function assigneeLabel(r: Route) {
    return r.agent ? `${r.agent.firstName} ${r.agent.lastName}` : r.courier ? courierName(r.courier) : '';
  }

  function handleExport() {
    if (!data) return;
    exportToCsv(`marshrutlar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('name'), value: (r) => r.name },
      { header: t('assignee'), value: (r) => assigneeLabel(r) },
      { header: t('weekday'), value: (r) => t(`weekdays.${r.weekday}`) },
      { header: t('stopCount'), value: (r) => r.stops.length },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canCreate && (
          <Link href="/routes/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newRoute')}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setCourierId('');
            setPage(1);
          }}
          className="w-auto"
        >
          <option value="">{t('allAgents')}</option>
          {agents?.data.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.firstName} {agent.lastName}
            </option>
          ))}
        </Select>
        <Select
          value={courierId}
          onChange={(e) => {
            setCourierId(e.target.value);
            setAgentId('');
            setPage(1);
          }}
          className="w-auto"
        >
          <option value="">{t('allCouriers')}</option>
          {couriers?.data.map((courier) => (
            <option key={courier.id} value={courier.id}>
              {courierName(courier)}
            </option>
          ))}
        </Select>
        <Select
          value={weekday}
          onChange={(e) => {
            setWeekday(e.target.value);
            setPage(1);
          }}
          className="w-auto"
        >
          <option value="">{t('allWeekdays')}</option>
          {WEEKDAYS.map((day) => (
            <option key={day} value={day}>
              {t(`weekdays.${day}`)}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
          {t('refresh')}
        </Button>

        <ExportCsvButton onExport={handleExport} disabled={!data || data.data.length === 0} />
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      )}

      {isError && !isLoading && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {data && data.data.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Map className="h-10 w-10 text-muted-foreground" />
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptyFiltered')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
                {canCreate && (
                  <Link href="/routes/new" className={buttonVariants({ size: 'sm' })}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('newRoute')}
                  </Link>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <RoutesTable routes={data.data} />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
