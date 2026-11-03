'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, PackagePlus, RefreshCw, PackageCheck } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import { useReceiptsQuery, useSuppliersQuery } from '@/lib/api/purchases';
import { useWarehousesQuery } from '@/lib/api/warehouses';
import { formatDate, formatQty } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { PurchasesSubnav } from '@/components/purchases/purchases-subnav';
import { NoPermission } from '@/components/purchases/no-permission';
import { cn } from '@/lib/utils';

export default function ReceiptsPage() {
  const t = useTranslations('Purchases');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('purchases.read');
  const canReceive = hasPermission('purchases.receive');

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const { data: suppliers } = useSuppliersQuery({ pageSize: 100 }, canRead);
  const { data: warehouses } = useWarehousesQuery(canRead);
  const { data, isLoading, isError, error, refetch, isFetching } = useReceiptsQuery(
    {
      page,
      pageSize: 25,
      sortBy: 'receivedAt',
      dir: 'desc',
      supplierId: supplierId || undefined,
      warehouseId: warehouseId || undefined,
      from: from || undefined,
      to: to || undefined,
    },
    canRead,
  );

  if (!canRead) return <NoPermission />;

  const hasFilters = !!(supplierId || warehouseId || from || to);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('receiptsTitle')}</h1>
        {canReceive && (
          <Link href="/purchases/receive" className={buttonVariants({ variant: 'outline' })}>
            <PackagePlus className="mr-2 h-4 w-4" />
            {t('newReceipt')}
          </Link>
        )}
      </div>

      <PurchasesSubnav />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-[220px] space-y-1">
          <Label htmlFor="rc-supplier">{t('filters.supplier')}</Label>
          <Select
            id="rc-supplier"
            value={supplierId}
            onChange={(e) => {
              setSupplierId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('filters.allSuppliers')}</option>
            {suppliers?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full max-w-[220px] space-y-1">
          <Label htmlFor="rc-warehouse">{t('warehouse')}</Label>
          <Select
            id="rc-warehouse"
            value={warehouseId}
            onChange={(e) => {
              setWarehouseId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('allWarehouses')}</option>
            {warehouses?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rc-from">{t('filters.from')}</Label>
          <Input
            id="rc-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rc-to">{t('filters.to')}</Label>
          <Input
            id="rc-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
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
            <PackageCheck className="h-10 w-10 text-muted-foreground" />
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptyFiltered')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyReceipts')}</p>
                {canReceive && (
                  <Link href="/purchases/receive" className={buttonVariants({ size: 'sm' })}>
                    <PackagePlus className="mr-2 h-4 w-4" />
                    {t('newReceipt')}
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('receiptDate')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('receiptPo')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('supplier')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('warehouse')}</th>
                    <th className="pb-2 pr-3 text-right font-medium">{t('receiptLines')}</th>
                    <th className="pb-2 pr-3 text-right font-medium">{t('receiptTotalQty')}</th>
                    <th className="pb-2 font-medium">{t('receivedBy')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.data.map((r) => (
                    <tr key={r.id} className="hover:bg-accent/50">
                      <td className="py-2 pr-3">{formatDate(r.receivedAt, locale)}</td>
                      <td className="py-2 pr-3">
                        {r.purchaseOrder ? (
                          <Link href={`/purchases/${r.purchaseOrder.id}`} className="font-medium text-primary hover:underline">
                            {r.purchaseOrder.number}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{t('noPo')}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">{r.supplier?.name ?? '—'}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.warehouse.name}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.lineCount}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatQty(r.totalQty)}</td>
                      <td className="py-2 text-muted-foreground">
                        {r.receivedBy ? `${r.receivedBy.firstName} ${r.receivedBy.lastName}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
