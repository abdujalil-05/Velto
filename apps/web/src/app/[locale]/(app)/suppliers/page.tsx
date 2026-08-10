'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, RefreshCw, Search, Truck } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useSuppliersQuery,
  useDeleteSupplierMutation,
  useActivateSupplierMutation,
  useUnlinkSupplierTelegramMutation,
  type Supplier,
} from '@/lib/api/suppliers';
import { useOrdersQuery } from '@/lib/api/orders';
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
import { SuppliersTable } from '@/components/suppliers/suppliers-table';
import { SupplierFormDialog } from '@/components/suppliers/supplier-form-dialog';
import { SupplierTelegramDialog } from '@/components/suppliers/supplier-telegram-dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

export default function SuppliersPage() {
  const t = useTranslations('Suppliers');
  const tTelegram = useTranslations('Suppliers.telegram');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('purchases.create');
  const canUpdate = hasPermission('purchases.update');
  const canSeeOrders = hasPermission('orders.read');
  const canReadTelegram = hasPermission('purchases.read');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const { sort, toggle: toggleSort } = useSort();

  const { data, isLoading, isError, error, refetch, isFetching } = useSuppliersQuery({
    page,
    pageSize: 25,
    search: debouncedSearch || undefined,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
  });

  // GET /orders has no supplierId filter (only agentId/customerId/status/date-range) — pull a
  // generous page and derive per-supplier "assigned as deliverer" counts client-side. Orders only
  // ever carry a supplierId once shipped straight to a deliverer, so this stays a small set in practice.
  const { data: ordersForSupplierCounts } = useOrdersQuery(
    { page: 1, pageSize: 200, sortBy: 'createdAt', sortDir: 'desc' },
    canSeeOrders,
  );
  const orderCountBySupplierId = useMemo(() => {
    const map = new Map<string, number>();
    for (const order of ordersForSupplierCounts?.data ?? []) {
      if (!order.supplierId) continue;
      map.set(order.supplierId, (map.get(order.supplierId) ?? 0) + 1);
    }
    return map;
  }, [ordersForSupplierCounts]);

  function handleExport() {
    if (!data) return;
    exportToCsv(`yetkazib-beruvchilar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('name'), value: (s) => s.name },
      { header: t('phone'), value: (s) => s.phone ?? '' },
      { header: t('address'), value: (s) => s.address ?? '' },
      { header: t('status'), value: (s) => (s.isActive ? t('active') : t('inactive')) },
    ]);
  }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  const deleteMutation = useDeleteSupplierMutation();
  const activateMutation = useActivateSupplierMutation();
  const [togglingId, setTogglingId] = useState<string | undefined>();
  const [pendingDeactivate, setPendingDeactivate] = useState<Supplier | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Telegram link management. The unlink ConfirmDialog lives here rather than
  // inside SupplierTelegramDialog because `Dialog` doesn't support nesting —
  // so opening the confirmation closes the Telegram dialog first.
  const [telegramSupplier, setTelegramSupplier] = useState<Supplier | null>(null);
  const [pendingUnlink, setPendingUnlink] = useState<Supplier | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const unlinkTelegramMutation = useUnlinkSupplierTelegramMutation();

  function requestUnlinkTelegram(supplier: Supplier) {
    setTelegramSupplier(null);
    setUnlinkError(null);
    setPendingUnlink(supplier);
  }

  async function confirmUnlinkTelegram() {
    if (!pendingUnlink) return;
    setUnlinkError(null);
    try {
      await unlinkTelegramMutation.mutateAsync(pendingUnlink.id);
      toast.success(tTelegram('unlinkSuccess', { name: pendingUnlink.name }));
      setPendingUnlink(null);
    } catch (err) {
      setUnlinkError(errorMessage(err, locale));
    }
  }

  function openCreate() {
    setEditingSupplier(null);
    setDialogOpen(true);
  }

  function openEdit(supplier: Supplier) {
    setEditingSupplier(supplier);
    setDialogOpen(true);
  }

  // Deactivation is destructive (DELETE /suppliers/:id) — always confirm first.
  // Re-activation is harmless, so it fires straight away.
  async function toggleActive(supplier: Supplier) {
    if (supplier.isActive) {
      setPendingDeactivate(supplier);
      return;
    }
    setTogglingId(supplier.id);
    try {
      await activateMutation.mutateAsync(supplier.id);
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
      await deleteMutation.mutateAsync(pendingDeactivate.id);
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
            {t('newSupplier')}
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
                    {t('newSupplier')}
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
            <SuppliersTable
              suppliers={data.data}
              canUpdate={canUpdate}
              canReadTelegram={canReadTelegram}
              onEdit={openEdit}
              onToggleActive={toggleActive}
              onOpenTelegram={setTelegramSupplier}
              togglingId={togglingId}
              sort={sort}
              onSort={toggleSort}
              orderCountBySupplierId={orderCountBySupplierId}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <SupplierFormDialog open={dialogOpen} onOpenChange={setDialogOpen} supplier={editingSupplier} />

      <SupplierTelegramDialog
        open={telegramSupplier !== null}
        onOpenChange={(open) => {
          if (!open) setTelegramSupplier(null);
        }}
        supplier={telegramSupplier}
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
        description={tTelegram('confirmUnlink.description', { name: pendingUnlink?.name ?? '' })}
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
        description={tCommon('confirmDeactivate.description', { name: pendingDeactivate?.name ?? '' })}
        confirmLabel={tCommon('confirmDeactivate.confirm')}
        error={deactivateError}
        isPending={deleteMutation.isPending}
        onConfirm={confirmDeactivate}
      />
    </div>
  );
}
