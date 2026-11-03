'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertCircle, Pencil, Plus, RefreshCw, Search, Truck, UserX } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import { useDeactivateSupplierMutation, useSuppliersQuery, type Supplier } from '@/lib/api/purchases';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { PurchasesSubnav } from '@/components/purchases/purchases-subnav';
import { SupplierDialog } from '@/components/purchases/supplier-dialog';
import { NoPermission } from '@/components/purchases/no-permission';
import { cn } from '@/lib/utils';

export default function SuppliersPage() {
  const t = useTranslations('Purchases');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('purchases.read');
  const canManage = hasPermission('purchases.create');

  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, isLoading, isError, error, refetch, isFetching } = useSuppliersQuery(
    {
      page,
      pageSize: 25,
      search: debouncedSearch || undefined,
      isActive: activeFilter === '' ? undefined : activeFilter === 'true',
    },
    canRead,
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const deactivate = useDeactivateSupplierMutation();
  const [pendingDeactivate, setPendingDeactivate] = useState<Supplier | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  if (!canRead) return <NoPermission />;

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function confirmDeactivate() {
    if (!pendingDeactivate) return;
    setDeactivateError(null);
    try {
      await deactivate.mutateAsync(pendingDeactivate.id);
      toast.success(t('suppliers.deactivated', { name: pendingDeactivate.name }));
      setPendingDeactivate(null);
    } catch (err) {
      setDeactivateError(errorMessage(err, locale));
    }
  }

  const hasFilters = debouncedSearch.length > 0 || activeFilter !== '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('suppliers.new')}
          </Button>
        )}
      </div>

      <PurchasesSubnav />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('suppliers.searchPlaceholder')}
            aria-label={t('suppliers.searchPlaceholder')}
            className="pl-9"
          />
        </div>
        <div className="w-full max-w-[200px]">
          <Select
            value={activeFilter}
            aria-label={t('suppliers.statusFilter')}
            onChange={(e) => {
              setActiveFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('suppliers.all')}</option>
            <option value="true">{t('suppliers.active')}</option>
            <option value="false">{t('suppliers.inactive')}</option>
          </Select>
        </div>
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
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorMessage(error, locale)}
            </span>
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
              <p className="text-sm text-muted-foreground">{t('emptyFiltered')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('suppliers.empty')}</p>
                {canManage && (
                  <Button size="sm" onClick={openCreate}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('suppliers.new')}
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('supplierForm.name')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('supplierForm.inn')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('supplierForm.phone')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('statusLabel')}</th>
                    {canManage && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.data.map((s) => (
                    <tr key={s.id} className="hover:bg-accent/50">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{s.name}</div>
                        {s.legalName && <div className="text-xs text-muted-foreground">{s.legalName}</div>}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{s.inn ?? '—'}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{s.phone ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={s.isActive ? 'success' : 'outline'}>
                          {s.isActive ? t('suppliers.active') : t('suppliers.inactive')}
                        </Badge>
                      </td>
                      {canManage && (
                        <td className="py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('suppliers.edit')}
                            onClick={() => {
                              setEditing(s);
                              setDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {s.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('suppliers.deactivate')}
                              onClick={() => {
                                setDeactivateError(null);
                                setPendingDeactivate(s);
                              }}
                            >
                              <UserX className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <SupplierDialog open={dialogOpen} onOpenChange={setDialogOpen} supplier={editing} />

      <ConfirmDialog
        open={pendingDeactivate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeactivate(null);
            setDeactivateError(null);
          }
        }}
        title={t('suppliers.confirmDeactivate.title')}
        description={t('suppliers.confirmDeactivate.description', { name: pendingDeactivate?.name ?? '' })}
        confirmLabel={t('suppliers.deactivate')}
        error={deactivateError}
        isPending={deactivate.isPending}
        onConfirm={confirmDeactivate}
      />
    </div>
  );
}
