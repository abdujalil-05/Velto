'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Lock, MapPin, RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { GPS_STATUSES, useVisitsQuery, type GpsStatus } from '@/lib/api/visits';
import { useUsersQuery } from '@/lib/api/users';
import { errorMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { VisitsTable } from '@/components/visits/visits-table';
import { cn } from '@/lib/utils';

export default function VisitsPage() {
  const t = useTranslations('Visits');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('field.read');

  const [agentId, setAgentId] = useState('');
  const [gpsStatus, setGpsStatus] = useState('');
  const [page, setPage] = useState(1);

  const { data: agents } = useUsersQuery({ roleCode: 'SALES_AGENT', isActive: true, pageSize: 100 }, canRead);
  const { data, isLoading, isError, error, refetch, isFetching } = useVisitsQuery(
    {
      page,
      pageSize: 25,
      agentId: agentId || undefined,
      gpsStatus: (gpsStatus || undefined) as GpsStatus | undefined,
    },
    canRead,
  );
  const hasFilters = !!agentId || !!gpsStatus;

  if (!canRead) {
    return (
      <Alert>
        <AlertDescription className="flex items-center gap-2">
          <Lock className="h-4 w-4" />
          {t('noPermission')}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setPage(1);
          }}
          className="w-auto"
          aria-label={t('agent')}
        >
          <option value="">{t('allAgents')}</option>
          {agents?.data.map((a) => (
            <option key={a.id} value={a.id}>
              {a.firstName} {a.lastName}
            </option>
          ))}
        </Select>
        <Select
          value={gpsStatus}
          onChange={(e) => {
            setGpsStatus(e.target.value);
            setPage(1);
          }}
          className="w-auto"
          aria-label={t('gpsStatus')}
        >
          <option value="">{t('allGps')}</option>
          {GPS_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`gps.${s}`)}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
          {t('refresh')}
        </Button>
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
            <MapPin className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">{hasFilters ? t('emptyFiltered') : t('emptyState')}</p>
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <VisitsTable visits={data.data} />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
