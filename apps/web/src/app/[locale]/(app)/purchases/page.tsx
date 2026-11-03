'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, PackagePlus, Plus, RefreshCw, ShoppingBag } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import { usePurchaseOrdersQuery, useSuppliersQuery, type PurchaseOrderStatus } from '@/lib/api/purchases';
import { formatDate, formatMoney } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { PoStatusBadge } from '@/components/purchases/po-status-badge';
import { PurchasesSubnav } from '@/components/purchases/purchases-subnav';
import { NoPermission } from '@/components/purchases/no-permission';
import { cn } from '@/lib/utils';

const STATUSES: PurchaseOrderStatus[] = ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];

export default function PurchasesPage() {
  const t = useTranslations('Purchases');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('purchases.read');
  const canCreate = hasPermission('purchases.create');
  const canReceive = hasPermission('purchases.receive');

  const [status, setStatus] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const { data: suppliers } = useSuppliersQuery({ pageSize: 100 }, canRead);
  const { data, isLoading, isError, error, refetch, isFetching } = usePurchaseOrdersQuery({
    page,
    pageSize: 25,
    status: (status || undefined) as PurchaseOrderStatus | undefined,
    supplierId: supplierId || undefined,
    from: from || undefined,
    to: to || undefined,
  });

  if (!canRead) return <NoPermission />;

  const hasFilters = !!(status || supplierId || from || to);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <div className="flex flex-wrap gap-2">
          {canReceive && (
            <Link href="/purchases/receive" className={buttonVariants({ variant: 'outline' })}>
              <PackagePlus className="mr-2 h-4 w-4" />
              {t('newReceipt')}
            </Link>
          )}
          {canCreate && (
            <Link href="/purchases/new" className={buttonVariants({})}>
              <Plus className="mr-2 h-4 w-4" />
              {t('newOrder')}
            </Link>
          )}
        </div>
      </div>

      <PurchasesSubnav />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-[200px] space-y-1">
          <Label htmlFor="po-status">{t('filters.status')}</Label>
          <Select
            id="po-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('filters.allStatuses')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full max-w-[220px] space-y-1">
          <Label htmlFor="po-supplier">{t('filters.supplier')}</Label>
          <Select
            id="po-supplier"
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
        <div className="space-y-1">
          <Label htmlFor="po-from">{t('filters.from')}</Label>
          <Input
            id="po-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="po-to">{t('filters.to')}</Label>
          <Input
            id="po-to"
            type="date"
            value={to}
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
            <ShoppingBag className="h-10 w-10 text-muted-foreground" />
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptyFiltered')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyOrders')}</p>
                {canCreate && (
                  <Link href="/purchases/new" className={buttonVariants({ size: 'sm' })}>
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('number')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('supplier')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('warehouse')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('expectedAt')}</th>
                    <th className="pb-2 pr-3 text-right font-medium">{t('total')}</th>
                    <th className="pb-2 font-medium">{t('statusLabel')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.data.map((po) => (
                    <tr key={po.id} className="hover:bg-accent/50">
                      <td className="py-2 pr-3">
                        <Link href={`/purchases/${po.id}`} className="font-medium text-primary hover:underline">
                          {po.number}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">{po.supplier.name}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{po.warehouse.name}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{po.expectedAt ? formatDate(po.expectedAt, locale) : '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatMoney(po.totalAmount)} {t('somUnit')}
                      </td>
                      <td className="py-2">
                        <PoStatusBadge status={po.status} />
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
