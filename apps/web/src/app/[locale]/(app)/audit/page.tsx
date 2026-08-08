'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { History, RefreshCw } from 'lucide-react';
import { useAuditLogQuery } from '@/lib/api/audit';
import { errorMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { AuditLogTable } from '@/components/audit/audit-log-table';
import { cn } from '@/lib/utils';

export default function AuditPage() {
  const t = useTranslations('Audit');
  const locale = useLocale();

  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, refetch, isFetching } = useAuditLogQuery({ page, pageSize: 25 });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
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
            <History className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('emptyState')}</p>
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <AuditLogTable entries={data.data} />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
