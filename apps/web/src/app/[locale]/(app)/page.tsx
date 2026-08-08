'use client';

import { useLocale, useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { useDashboardQuery } from '@/lib/api/dashboard';
import { errorMessage } from '@/lib/api/client';
import { formatMoney } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/dashboard/stat-card';
import { TurnoverChart } from '@/components/dashboard/turnover-chart';
import { AgentsTodayTable } from '@/components/dashboard/agents-today-table';
import { TopDebtorsList } from '@/components/dashboard/top-debtors-list';

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 lg:col-span-2" />
        <Skeleton className="h-64" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}

function NoDashboardAccess() {
  const t = useTranslations('Dashboard');
  const { user } = useAuth();
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <CardTitle>{t('welcome', { name: user?.firstName ?? '' })}</CardTitle>
        <p className="max-w-sm text-sm text-muted-foreground">{t('noAccessYet')}</p>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const t = useTranslations('Dashboard');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canViewDashboard = hasPermission('reports.read');
  const { data, isLoading, isError, error, refetch, isFetching } = useDashboardQuery(canViewDashboard);

  if (!canViewDashboard) {
    return <NoDashboardAccess />;
  }

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{errorMessage(error, locale)}</span>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const unit = tCommon('somUnit');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          {t('refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('todayTurnover')} value={formatMoney(data.today.turnover)} unit={unit} changePct={data.today.turnoverChangePct} />
        <StatCard label={t('orderCount')} value={String(data.today.orderCount)} changePct={data.today.orderCountChangePct} />
        <StatCard label={t('collected')} value={formatMoney(data.today.collected)} unit={unit} changePct={data.today.collectedChangePct} />
        <StatCard
          label={t('overdueDebt')}
          value={formatMoney(data.today.overdueDebt)}
          unit={unit}
          changePct={data.today.overdueDebtChangePct}
          invertTrend
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('turnoverTrend')}</CardTitle>
          </CardHeader>
          <CardContent>
            <TurnoverChart data={data.turnoverLast30Days} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('agentsToday')}</CardTitle>
          </CardHeader>
          <CardContent>
            <AgentsTodayTable agents={data.agentsToday} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('topDebtors')}</CardTitle>
        </CardHeader>
        <CardContent>
          <TopDebtorsList debtors={data.topDebtors} />
        </CardContent>
      </Card>
    </div>
  );
}
