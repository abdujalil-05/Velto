'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { PackageSearch, PlusCircle, RefreshCw } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useStockLevelsQuery } from '@/lib/api/stock';
import { errorMessage } from '@/lib/api/client';
import { useSort } from '@/lib/hooks/use-sort';
import { exportToCsv } from '@/lib/export-csv';
import { formatQty } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { StockTable } from '@/components/stock/stock-table';
import { cn } from '@/lib/utils';

export default function StockPage() {
  const t = useTranslations('Stock');
  const locale = useLocale();
  const { hasPermission } = useAuth();

  const [page, setPage] = useState(1);
  const { sort, toggle: toggleSort } = useSort();

  const { data, isLoading, isError, error, refetch, isFetching } = useStockLevelsQuery({
    page,
    pageSize: 25,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
  });

  function handleExport() {
    if (!data) return;
    exportToCsv(`qoldiq-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('product'), value: (r) => r.product.name },
      { header: t('warehouse'), value: (r) => r.warehouse.name },
      { header: t('onHand'), value: (r) => formatQty(r.onHand) },
      { header: t('reserved'), value: (r) => formatQty(r.reserved) },
      { header: t('available'), value: (r) => formatQty(r.available) },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <div className="flex gap-2">
          {hasPermission('stock.receive') && (
            <Link href="/stock/receive" className={buttonVariants({})}>
              <PlusCircle className="mr-2 h-4 w-4" />
              {t('receiveAction')}
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
            <PackageSearch className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('emptyState')}</p>
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <StockTable rows={data.data} sort={sort} onSort={toggleSort} />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
