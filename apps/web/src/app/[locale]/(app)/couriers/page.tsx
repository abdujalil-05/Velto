'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, RefreshCw, Search, Truck } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useCouriersQuery,
  useUnlinkCourierTelegramMutation,
  courierName,
  type Courier,
} from '@/lib/api/couriers';
import { useActivateUserMutation, useDeactivateUserMutation } from '@/lib/api/users';
import { errorMessage } from '@/lib/api/client';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useSort } from '@/lib/hooks/use-sort';
import { exportToCsv } from '@/lib/export-csv';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { CouriersTable } from '@/components/couriers/couriers-table';
import { CourierFormDialog } from '@/components/couriers/courier-form-dialog';
import { CourierTelegramDialog } from '@/components/couriers/courier-telegram-dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

export default function CouriersPage() {
  const t = useTranslations('Couriers');
  const tTelegram = useTranslations('Couriers.telegram');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  // A courier is a User carrying the COURIER role, so the users permissions gate this screen.
  const canCreate = hasPermission('users.create');
  const canUpdate = hasPermission('users.update');
  const canReadTelegram = hasPermission('users.read');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const { sort, toggle: toggleSort } = useSort();

  const { data, isLoading, isError, error, refetch, isFetching } = useCouriersQuery({
    page,
    pageSize: 25,
    search: debouncedSearch || undefined,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
  });

  function handleExport() {
    if (!data) return;
    exportToCsv(`kuryerlar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('name'), value: (c) => courierName(c) },
      { header: t('phone'), value: (c) => c.phone ?? '' },
      { header: t('status'), value: (c) => (c.isActive ? t('active') : t('inactive')) },
    ]);
  }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCourier, setEditingCourier] = useState<Courier | null>(null);

  const deactivateMutation = useDeactivateUserMutation();
  const activateMutation = useActivateUserMutation();
  const [togglingId, setTogglingId] = useState<string | undefined>();
  const [pendingDeactivate, setPendingDeactivate] = useState<Courier | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Telegram link management. The unlink ConfirmDialog lives here rather than
  // inside CourierTelegramDialog because `Dialog` doesn't support nesting —
  // so opening the confirmation closes the Telegram dialog first.
  const [telegramCourier, setTelegramCourier] = useState<Courier | null>(null);
  const [pendingUnlink, setPendingUnlink] = useState<Courier | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const unlinkTelegramMutation = useUnlinkCourierTelegramMutation();

  function requestUnlinkTelegram(courier: Courier) {
    setTelegramCourier(null);
    setUnlinkError(null);
    setPendingUnlink(courier);
  }

  async function confirmUnlinkTelegram() {
    if (!pendingUnlink) return;
    setUnlinkError(null);
    try {
      await unlinkTelegramMutation.mutateAsync(pendingUnlink.id);
      toast.success(tTelegram('unlinkSuccess', { name: courierName(pendingUnlink) }));
      setPendingUnlink(null);
    } catch (err) {
      setUnlinkError(errorMessage(err, locale));
    }
  }

  function openCreate() {
    setEditingCourier(null);
    setDialogOpen(true);
  }

  function openEdit(courier: Courier) {
    setEditingCourier(courier);
    setDialogOpen(true);
  }

  // Deactivation locks the courier out — always confirm first. Re-activation is
  // harmless, so it fires straight away.
  async function toggleActive(courier: Courier) {
    if (courier.isActive) {
      setPendingDeactivate(courier);
      return;
    }
    setTogglingId(courier.id);
    try {
      await activateMutation.mutateAsync(courier.id);
    } catch (err) {
      toast.error(errorMessage(err, locale));
    } finally {
      setTogglingId(undefined);
    }
  }

  async function confirmDeactivate() {
    if (!pendingDeactivate) return;
    setDeactivateError(null);
    setTogglingId(pendingDeactivate.id);
    try {
      await deactivateMutation.mutateAsync(pendingDeactivate.id);
      setPendingDeactivate(null);
    } catch (err) {
      setDeactivateError(errorMessage(err, locale));
    } finally {
      setTogglingId(undefined);
    }
  }

  const hasFilters = debouncedSearch.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canCreate && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newCourier')}
          </Button>
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
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptySearch')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
                {canCreate && (
                  <Button size="sm" onClick={openCreate}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('newCourier')}
                  </Button>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <CouriersTable
              couriers={data.data}
              canUpdate={canUpdate}
              canReadTelegram={canReadTelegram}
              onEdit={openEdit}
              onToggleActive={toggleActive}
              onOpenTelegram={setTelegramCourier}
              togglingId={togglingId}
              sort={sort}
              onSort={toggleSort}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <CourierFormDialog open={dialogOpen} onOpenChange={setDialogOpen} courier={editingCourier} />

      <CourierTelegramDialog
        open={telegramCourier !== null}
        onOpenChange={(open) => {
          if (!open) setTelegramCourier(null);
        }}
        courier={telegramCourier}
        canUpdate={canUpdate}
        onRequestUnlink={requestUnlinkTelegram}
      />

      <ConfirmDialog
        open={pendingUnlink !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingUnlink(null);
            setUnlinkError(null);
          }
        }}
        title={tTelegram('confirmUnlink.title')}
        description={tTelegram('confirmUnlink.description', { name: pendingUnlink ? courierName(pendingUnlink) : '' })}
        confirmLabel={tTelegram('confirmUnlink.confirm')}
        error={unlinkError}
        isPending={unlinkTelegramMutation.isPending}
        onConfirm={confirmUnlinkTelegram}
      />

      <ConfirmDialog
        open={pendingDeactivate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeactivate(null);
            setDeactivateError(null);
          }
        }}
        title={tCommon('confirmDeactivate.title')}
        description={tCommon('confirmDeactivate.description', {
          name: pendingDeactivate ? courierName(pendingDeactivate) : '',
        })}
        confirmLabel={tCommon('confirmDeactivate.confirm')}
        error={deactivateError}
        isPending={deactivateMutation.isPending}
        onConfirm={confirmDeactivate}
      />
    </div>
  );
}
