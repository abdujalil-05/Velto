'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CreditCard, Plus, RefreshCw, Wallet } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import {
  useCashSessionsQuery,
  useCloseCashSessionMutation,
  useCurrentCashSessionQuery,
  useOpenCashSessionMutation,
} from '@/lib/api/cash-sessions';
import { usePaymentsQuery } from '@/lib/api/payments';
import { useCustomersQuery, type Customer } from '@/lib/api/customers';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useSort } from '@/lib/hooks/use-sort';
import { exportToCsv } from '@/lib/export-csv';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { SearchSelect } from '@/components/shared/search-select';
import { OpenSessionForm } from '@/components/cash/open-session-form';
import { CloseSessionForm } from '@/components/cash/close-session-form';
import { CashSessionsTable } from '@/components/cash/cash-sessions-table';
import { PaymentsTable } from '@/components/payments/payments-table';
import { cn } from '@/lib/utils';

export default function CashPage() {
  const t = useTranslations('Cash');
  const { hasPermission } = useAuth();

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {hasPermission('cash.read') && <CashSection />}
      {hasPermission('payments.read') && <PaymentsSection canCreate={hasPermission('payments.create')} />}
    </div>
  );
}

function CashSection() {
  const t = useTranslations('Cash');
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const [actionError, setActionError] = useState<string | null>(null);

  const current = useCurrentCashSessionQuery();
  const history = useCashSessionsQuery({ page, pageSize: 25 });
  const openMutation = useOpenCashSessionMutation();
  const closeMutation = useCloseCashSessionMutation();

  function handleExport() {
    if (!history.data) return;
    exportToCsv(`kassa-smenalari-${new Date().toISOString().slice(0, 10)}.csv`, history.data.data, [
      { header: t('cashier'), value: (s) => (s.user ? `${s.user.firstName} ${s.user.lastName}` : '') },
      { header: t('openedAt'), value: (s) => formatDateTime(s.openedAt, locale) },
      { header: t('closedAt'), value: (s) => (s.closedAt ? formatDateTime(s.closedAt, locale) : '') },
      { header: t('openAmount'), value: (s) => formatMoney(s.openAmount) },
      { header: t('closeAmount'), value: (s) => (s.closeAmount ? formatMoney(s.closeAmount) : '') },
      { header: t('totalCollected'), value: (s) => formatMoney(s.totalCollected) },
    ]);
  }

  return (
    <section className="space-y-4">
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>{current.data ? t('closeForm.title') : t('openForm.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {current.isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-1/2" />
            </div>
          )}

          {current.isError && !current.isLoading && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-4">
                <span>{errorMessage(current.error, locale)}</span>
                <Button variant="outline" size="sm" onClick={() => current.refetch()}>
                  {t('retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {!current.isLoading && !current.isError && current.data && (
            <CloseSessionForm
              session={current.data}
              isSubmitting={closeMutation.isPending}
              submitError={actionError}
              onSubmit={(closeAmount) => {
                setActionError(null);
                closeMutation.mutate(
                  { id: current.data!.id, closeAmount },
                  {
                    onSuccess: () => toast.success(t('closed')),
                    onError: (error) => setActionError(errorMessage(error, locale)),
                  },
                );
              }}
            />
          )}

          {!current.isLoading && !current.isError && !current.data && (
            <OpenSessionForm
              isSubmitting={openMutation.isPending}
              submitError={actionError}
              onSubmit={(openAmount) => {
                setActionError(null);
                openMutation.mutate(openAmount, {
                  onSuccess: () => toast.success(t('opened')),
                  onError: (error) => setActionError(errorMessage(error, locale)),
                });
              }}
            />
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t('history')}</h2>
          <ExportCsvButton onExport={handleExport} disabled={!history.data || history.data.data.length === 0} />
        </div>

        {history.isLoading && (
          <Card>
            <CardContent className="space-y-2 py-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
        )}

        {history.isError && !history.isLoading && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{errorMessage(history.error, locale)}</span>
              <Button variant="outline" size="sm" onClick={() => history.refetch()}>
                {t('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {history.data && history.data.data.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <Wallet className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('emptyState')}</p>
            </CardContent>
          </Card>
        )}

        {history.data && history.data.data.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <CashSessionsTable sessions={history.data.data} />
              <PaginationBar meta={history.data.meta} onPageChange={setPage} />
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}

function PaymentsSection({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations('Payments');
  const locale = useLocale();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [page, setPage] = useState(1);
  const debouncedCustomerQuery = useDebouncedValue(customerQuery, 300);
  const { sort, toggle: toggleSort } = useSort();

  const { data: customerOptions, isLoading: customersLoading } = useCustomersQuery({
    page: 1,
    pageSize: 10,
    search: debouncedCustomerQuery || undefined,
  });

  const { data, isLoading, isError, error, refetch, isFetching } = usePaymentsQuery({
    page,
    pageSize: 25,
    customerId: customer?.id,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
  });

  function handleExport() {
    if (!data) return;
    exportToCsv(`tolovlar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('number'), value: (p) => p.number },
      { header: t('customer'), value: (p) => p.customer.name },
      { header: t('date'), value: (p) => formatDateTime(p.createdAt, locale) },
      { header: t('method'), value: (p) => t(`methods.${p.method}`) },
      { header: t('amount'), value: (p) => formatMoney(p.amount) },
    ]);
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">{t('title')}</h2>
        {canCreate && (
          <Link href="/payments/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newPayment')}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
            placeholder={t('form.searchCustomer')}
            emptyText={t('form.noCustomers')}
          />
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
            <CreditCard className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('emptyState')}</p>
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <PaymentsTable payments={data.data} sort={sort} onSort={toggleSort} />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </section>
  );
}
