'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, RefreshCw, ShoppingCart, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useOrdersQuery, useDeleteOrderMutation, type SalesOrder } from '@/lib/api/orders';
import { useCustomersQuery, type Customer, type OrderStatus } from '@/lib/api/customers';
import { useUserQuery } from '@/lib/api/users';
import { errorMessage } from '@/lib/api/client';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useSort } from '@/lib/hooks/use-sort';
import { useInitialQueryParam } from '@/lib/hooks/use-initial-query-param';
import { exportToCsv } from '@/lib/export-csv';
import { formatDate, formatMoney } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { SearchSelect } from '@/components/shared/search-select';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { OrdersTable } from '@/components/orders/orders-table';
import { cn } from '@/lib/utils';

const STATUS_FILTERS: ('all' | OrderStatus)[] = ['all', 'SUBMITTED', 'CONFIRMED', 'DELIVERED', 'CLOSED', 'CANCELLED'];

export default function OrdersPage() {
  const t = useTranslations('Orders');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canDelete = hasPermission('orders.update');

  const [status, setStatus] = useState<'all' | OrderStatus>('all');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [page, setPage] = useState(1);
  const debouncedCustomerQuery = useDebouncedValue(customerQuery, 300);
  const { sort, toggle: toggleSort } = useSort();

  // Deep-linked from the couriers list ("N orders" link) — `GET /orders` filters
  // on courierId server-side, so this only swaps the status/customer filter bar
  // for a "showing courier X" banner.
  const courierIdFilter = useInitialQueryParam('courierId');
  const { data: filterCourier } = useUserQuery(courierIdFilter);

  const { data: customerOptions, isLoading: customersLoading } = useCustomersQuery({
    page: 1,
    pageSize: 10,
    search: debouncedCustomerQuery || undefined,
  });

  const { data, isLoading, isError, error, refetch, isFetching } = useOrdersQuery(
    courierIdFilter
      ? { page, pageSize: 25, courierId: courierIdFilter, sortBy: 'createdAt', sortDir: 'desc' }
      : {
          page,
          pageSize: 25,
          status: status === 'all' ? undefined : status,
          customerId: customer?.id,
          sortBy: sort.sortBy,
          sortDir: sort.sortDir,
        },
  );

  const deleteMutation = useDeleteOrderMutation();
  const [pendingDelete, setPendingDelete] = useState<SalesOrder | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(pendingDelete.id);
      toast.success(t('deleteSuccess', { number: pendingDelete.number }));
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(errorMessage(err, locale));
    }
  }

  const hasFilters = status !== 'all' || !!customer || !!courierIdFilter;

  function handleExport() {
    if (!data) return;
    exportToCsv(`buyurtmalar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('number'), value: (o) => o.number },
      { header: t('customer'), value: (o) => o.customer.name },
      { header: t('date'), value: (o) => formatDate(o.createdAt, locale) },
      { header: t('total'), value: (o) => formatMoney(o.total) },
      { header: t('status'), value: (o) => o.status },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {hasPermission('orders.create') && (
          <Link href="/orders/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newOrder')}
          </Link>
        )}
      </div>

      {courierIdFilter ? (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {t('courierFilterBanner', {
                name: filterCourier ? `${filterCourier.firstName} ${filterCourier.lastName}` : '…',
              })}
            </span>
            <Link href="/orders" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <X className="h-3.5 w-3.5" />
              {t('clearCourierFilter')}
            </Link>
          </AlertDescription>
        </Alert>
      ) : (
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

          <div className="w-full max-w-xs">
            <SearchSelect
              selected={customer}
              onSelect={(c) => {
                setCustomer(c);
                setPage(1);
              }}
              query={customerQuery}
              onQueryChange={setCustomerQuery}
              items={customerOptions?.data ?? []}
              isLoading={customersLoading}
              getId={(c) => c.id}
              getLabel={(c) => c.name}
              getDescription={(c) => c.code}
              placeholder={t('customerFilterPlaceholder')}
              emptyText={t('form.noCustomers')}
            />
          </div>

          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
            {t('refresh')}
          </Button>

          <ExportCsvButton onExport={handleExport} disabled={!data || data.data.length === 0} />
        </div>
      )}

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
            <ShoppingCart className="h-10 w-10 text-muted-foreground" />
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptyFiltered')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
                {hasPermission('orders.create') && (
                  <Link href="/orders/new" className={buttonVariants({ size: 'sm' })}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('newOrder')}
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
            <OrdersTable
              orders={data.data}
              sort={sort}
              onSort={toggleSort}
              canDelete={canDelete}
              onDelete={(order) => {
                setDeleteError(null);
                setPendingDelete(order);
              }}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title={t('confirmDelete.title')}
        description={t('confirmDelete.description', { number: pendingDelete?.number ?? '' })}
        confirmLabel={t('delete')}
        error={deleteError}
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
