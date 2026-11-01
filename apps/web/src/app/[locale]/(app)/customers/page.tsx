'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, RefreshCw, Search, Users } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useCustomersQuery, useDeleteCustomerMutation, useRestoreCustomerMutation, type Customer, type CustomerDeleteBlockers } from '@/lib/api/customers';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useSort } from '@/lib/hooks/use-sort';
import { formatMoney } from '@/lib/format';
import { exportToCsv, csvDecimal } from '@/lib/export-csv';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { CustomersTable } from '@/components/customers/customers-table';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

type BlockedFilter = 'all' | 'active' | 'blocked' | 'deleted';

export default function CustomersPage() {
  const t = useTranslations('Customers');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<BlockedFilter>('all');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const { sort, toggle: toggleSort } = useSort();
  const canDelete = hasPermission('customers.delete');
  const canRestore = hasPermission('customers.restore');
  const showDeleted = canRestore && filter === 'deleted';

  const { data, isLoading, isError, error, refetch, isFetching } = useCustomersQuery({
    page,
    pageSize: 25,
    search: debouncedSearch || undefined,
    isBlocked: filter === 'active' || filter === 'blocked' ? filter === 'blocked' : undefined,
    deleted: showDeleted || undefined,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
  });

  const deleteMutation = useDeleteCustomerMutation();
  const [pendingDelete, setPendingDelete] = useState<Customer | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Soft delete, cascading to the customer's outlets. The API refuses with a
  // 409 while the balance is non-zero, so surface its trilingual message inside
  // the dialog rather than closing on failure.
  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(pendingDelete.id);
      toast.success(t('deleteSuccess', { name: pendingDelete.name }));
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(deleteErrorText(err));
    }
  }

  // ADR-061c: CUSTOMER_HAS_OPEN_OBLIGATIONS carries details.blockers — list them.
  function deleteErrorText(err: unknown): string {
    const base = errorMessage(err, locale);
    const blockers = err instanceof ApiError ? (err.details as { blockers?: Partial<CustomerDeleteBlockers> } | undefined)?.blockers : undefined;
    if (!blockers) return base;
    const parts: string[] = [];
    for (const [status, count] of Object.entries(blockers.orders ?? {})) {
      if (count > 0) parts.push(t('deleteBlockers.orders', { count, status: t.has(`deleteBlockers.status.${status}`) ? t(`deleteBlockers.status.${status}`) : status }));
    }
    if (blockers.pendingHandover) parts.push(t('deleteBlockers.pendingHandover', { count: blockers.pendingHandover }));
    if (blockers.debt && Number(blockers.debt) !== 0) parts.push(t('deleteBlockers.debt', { amount: `${formatMoney(blockers.debt)} ${tCommon('somUnit')}` }));
    if (blockers.advance && Number(blockers.advance) !== 0) parts.push(t('deleteBlockers.advance', { amount: `${formatMoney(blockers.advance)} ${tCommon('somUnit')}` }));
    return parts.length ? `${base} ${t('deleteBlockers.intro')} ${parts.join('; ')}` : base;
  }

  const restoreMutation = useRestoreCustomerMutation();
  const [pendingRestore, setPendingRestore] = useState<Customer | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function confirmRestore() {
    if (!pendingRestore) return;
    setRestoreError(null);
    try {
      await restoreMutation.mutateAsync(pendingRestore.id);
      toast.success(t('restoreSuccess', { name: pendingRestore.name }));
      setPendingRestore(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CUSTOMER_CODE_CONFLICT_ON_RESTORE') {
        setRestoreError(t('restoreCodeConflict', { code: pendingRestore.code }));
      } else {
        setRestoreError(errorMessage(err, locale));
      }
    }
  }

  function handleExport() {
    if (!data) return;
    exportToCsv(
      `mijozlar-${new Date().toISOString().slice(0, 10)}.csv`,
      data.data,
      [
        { header: t('code'), value: (c) => c.code },
        { header: t('name'), value: (c) => c.name },
        { header: t('phone'), value: (c) => c.phone ?? '' },
        { header: t('balance'), value: (c) => csvDecimal(c.cachedBalance, 2) },
        { header: t('status'), value: (c) => (c.isBlocked ? t('blocked') : t('active')) },
      ],
    );
  }

  const hasFilters = debouncedSearch.length > 0 || filter !== 'all';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {hasPermission('customers.create') && (
          <Link href="/customers/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newCustomer')}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('searchPlaceholder')}
            className="pl-9"
          />
        </div>

        <div className="flex gap-1 rounded-md border border-border p-1">
          {((canRestore ? ['all', 'active', 'blocked', 'deleted'] : ['all', 'active', 'blocked']) as BlockedFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
              className={cn(
                'rounded px-3 py-1 text-sm font-medium transition-colors',
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
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
            <Users className="h-10 w-10 text-muted-foreground" />
            {hasFilters || showDeleted ? (
              <p className="text-sm text-muted-foreground">{showDeleted ? t('emptyDeleted') : t('emptySearch')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
                {hasPermission('customers.create') && (
                  <Link href="/customers/new" className={buttonVariants({ size: 'sm' })}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('newCustomer')}
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
            <CustomersTable
              customers={data.data}
              sort={sort}
              onSort={toggleSort}
              canDelete={canDelete && !showDeleted}
              canRestore={showDeleted}
              onRestore={(customer) => {
                setRestoreError(null);
                setPendingRestore(customer);
              }}
              onDelete={(customer) => {
                setDeleteError(null);
                setPendingDelete(customer);
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
        description={t('confirmDelete.description', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('delete')}
        error={deleteError}
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRestore(null);
            setRestoreError(null);
          }
        }}
        title={t('confirmRestore.title')}
        description={t('confirmRestore.description', { name: pendingRestore?.name ?? '' })}
        confirmLabel={t('restore')}
        error={restoreError}
        isPending={restoreMutation.isPending}
        onConfirm={confirmRestore}
      />
    </div>
  );
}
