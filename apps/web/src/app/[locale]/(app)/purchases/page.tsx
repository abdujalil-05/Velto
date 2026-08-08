'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, RefreshCw, Truck } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { usePurchaseOrdersQuery, type PurchaseOrder, type PurchaseOrderStatus } from '@/lib/api/purchase-orders';
import { errorMessage } from '@/lib/api/client';
import { exportToCsv } from '@/lib/export-csv';
import { formatDate, formatMoney } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { PurchaseOrdersTable } from '@/components/purchases/purchase-orders-table';
import { cn } from '@/lib/utils';

function poTotal(po: PurchaseOrder): number {
  return po.lines.reduce((sum, l) => sum + Number(l.qty) * Number(l.unitPrice), 0);
}

const STATUS_FILTERS: ('all' | PurchaseOrderStatus)[] = ['all', 'DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];

export default function PurchasesPage() {
  const t = useTranslations('Purchases');
  const locale = useLocale();
  const { hasPermission } = useAuth();

  const [status, setStatus] = useState<'all' | PurchaseOrderStatus>('all');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, refetch, isFetching } = usePurchaseOrdersQuery({
    page,
    pageSize: 25,
    status: status === 'all' ? undefined : status,
  });

  function handleExport() {
    if (!data) return;
    exportToCsv(`xaridlar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('number'), value: (po) => po.number },
      { header: t('supplier'), value: (po) => po.supplier.name },
      { header: t('date'), value: (po) => formatDate(po.createdAt, locale) },
      { header: t('total'), value: (po) => formatMoney(poTotal(po)) },
      { header: t('status'), value: (po) => po.status },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {hasPermission('purchases.create') && (
          <Link href="/purchases/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newPurchase')}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 overflow-x-auto rounded-md border border-border p-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setStatus(f);
                setPage(1);
              }}
              className={cn(
                'whitespace-nowrap rounded px-3 py-1 text-sm font-medium transition-colors',
                status === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t(`filter.${f}`)}
            </button>
          ))}
        </div>

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
            <Truck className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
            {hasPermission('purchases.create') && (
              <Link href="/purchases/new" className={buttonVariants({ size: 'sm' })}>
                <Plus className="mr-2 h-4 w-4" />
                {t('newPurchase')}
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <PurchaseOrdersTable purchaseOrders={data.data} />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
