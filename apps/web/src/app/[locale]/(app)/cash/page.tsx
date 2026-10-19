'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CreditCard, Plus, RefreshCw, Wallet } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { ApiError, errorMessage } from '@/lib/api/client';
import {
  useCashSessionsQuery,
  useCloseCashSessionMutation,
  useCurrentCashSessionQuery,
  useOpenCashSessionMutation,
} from '@/lib/api/cash-sessions';
import {
  usePaymentsQuery,
  useReversePaymentMutation,
  useAcceptHandoverMutation,
  useRejectHandoverMutation,
  type Payment,
} from '@/lib/api/payments';
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
import { ReverseDialog } from '@/components/shared/reverse-dialog';
import { PaymentsTable } from '@/components/payments/payments-table';
import { cn } from '@/lib/utils';

export default function CashPage() {
  const t = useTranslations('Cash');
  const { hasPermission } = useAuth();

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {hasPermission('cash.read') && <CashSection />}
      {hasPermission('payments.read') && <PaymentsSection canCreate={hasPermission('payments.create')} canReverse={hasPermission('payments.reverse')} canHandover={hasPermission('payments.handover')} />}
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
  // One key per close action, reused on retry until the server accepts it.
  const closeKey = useRef<string | null>(null);

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
    <section id="cash-session" className="space-y-4">
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
                  { id: current.data!.id, closeAmount, idempotencyKey: (closeKey.current ??= crypto.randomUUID()) },
                  {
                    onSuccess: () => {
                      closeKey.current = null;
                      toast.success(t('closed'));
                    },
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

function PaymentsSection({ canCreate, canReverse, canHandover }: { canCreate: boolean; canReverse: boolean; canHandover: boolean }) {
  const t = useTranslations('Payments');
  const locale = useLocale();
  const [reverseTarget, setReverseTarget] = useState<Payment | null>(null);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const reverseMutation = useReversePaymentMutation();
  // One key per reversal attempt, reused on retry until the server accepts it.
  const reverseKey = useRef<string | null>(null);
  const acceptMutation = useAcceptHandoverMutation();
  const rejectMutation = useRejectHandoverMutation();
  const [rejectTarget, setRejectTarget] = useState<Payment | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [handoverError, setHandoverError] = useState<{ code: string; message: string } | null>(null);
  // One key per payment+action, reused on retry until the server accepts it.
  const handoverKeys = useRef<Map<string, string>>(new Map());
  const handoverKey = (action: string, id: string) => {
    const k = `${action}:${id}`;
    if (!handoverKeys.current.has(k)) handoverKeys.current.set(k, crypto.randomUUID());
    return handoverKeys.current.get(k)!;
  };
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

      {handoverError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{handoverError.message}</span>
            {handoverError.code === 'PAYMENT_HANDOVER_CASH_SESSION_NOT_OPEN' && (
              <Link href="/cash#cash-session" className="font-medium underline">
                {t('handover.openSession')}
              </Link>
            )}
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
            <PaymentsTable
              payments={data.data}
              sort={sort}
              onSort={toggleSort}
              canReverse={canReverse}
              canHandover={canHandover}
              acceptingId={acceptMutation.isPending ? acceptMutation.variables?.id : null}
              onAccept={(payment) => {
                setHandoverError(null);
                acceptMutation.mutate(
                  { id: payment.id, idempotencyKey: handoverKey('accept', payment.id) },
                  {
                    onSuccess: () => {
                      handoverKeys.current.delete(`accept:${payment.id}`);
                      toast.success(t('handover.acceptSuccess'));
                    },
                    onError: (err) =>
                      setHandoverError({ code: err instanceof ApiError ? err.code : '', message: errorMessage(err, locale) }),
                  },
                );
              }}
              onReject={(payment) => {
                setRejectError(null);
                setRejectTarget(payment);
              }}
              onReverse={(payment) => {
                reverseKey.current = null;
                setReverseError(null);
                setReverseTarget(payment);
              }}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
      {rejectTarget && (
        <ReverseDialog
          key={`reject-${rejectTarget.id}`}
          open
          onOpenChange={(open) => !open && setRejectTarget(null)}
          title={t('handover.rejectTitle', { number: rejectTarget.number })}
          description={t('handover.rejectDescription')}
          confirmLabel={t('handover.reject')}
          error={rejectError}
          isPending={rejectMutation.isPending}
          onConfirm={(reason) => {
            setRejectError(null);
            rejectMutation.mutate(
              { id: rejectTarget.id, reason, idempotencyKey: handoverKey('reject', rejectTarget.id) },
              {
                onSuccess: () => {
                  handoverKeys.current.delete(`reject:${rejectTarget.id}`);
                  setRejectTarget(null);
                  toast.success(t('handover.rejectSuccess'));
                },
                onError: (err) => setRejectError(errorMessage(err, locale)),
              },
            );
          }}
        />
      )}
      {reverseTarget && (
        <ReverseDialog
          key={reverseTarget.id}
          open
          onOpenChange={(open) => !open && setReverseTarget(null)}
          title={t('reverse.title', { number: reverseTarget.number })}
          description={t('reverse.description')}
          error={reverseError}
          isPending={reverseMutation.isPending}
          onConfirm={(reason) => {
            setReverseError(null);
            reverseMutation.mutate(
              { id: reverseTarget.id, reason, idempotencyKey: (reverseKey.current ??= crypto.randomUUID()) },
              {
                onSuccess: () => {
                  reverseKey.current = null;
                  setReverseTarget(null);
                  toast.success(t('reverse.success'));
                },
                onError: (err) => setReverseError(errorMessage(err, locale)),
              },
            );
          }}
        />
      )}
    </section>
  );
}
