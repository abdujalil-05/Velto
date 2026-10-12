'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, PackagePlus } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import {
  useCancelPurchaseOrderMutation,
  useMarkOrderedMutation,
  usePurchaseOrderQuery,
} from '@/lib/api/purchases';
import { remainingQty } from '@/lib/decimal-qty';
import { formatDate, formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PoStatusBadge } from '@/components/purchases/po-status-badge';
import { NoPermission } from '@/components/purchases/no-permission';

export default function PurchaseOrderDetailPage() {
  const t = useTranslations('Purchases');
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('purchases.read');
  const canManage = hasPermission('purchases.create');
  const canReceive = hasPermission('purchases.receive');

  const { data: po, isLoading, isError, error, refetch } = usePurchaseOrderQuery(canRead ? id : '');
  const orderMutation = useMarkOrderedMutation();
  const cancelMutation = useCancelPurchaseOrderMutation();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  if (!canRead) return <NoPermission />;

  async function markOrdered() {
    setActionError(null);
    try {
      await orderMutation.mutateAsync(id);
      toast.success(t('detail.ordered'));
    } catch (err) {
      setActionError(errorMessage(err, locale));
    }
  }

  async function cancel() {
    setCancelError(null);
    try {
      await cancelMutation.mutateAsync(id);
      toast.success(t('detail.cancelled'));
      setConfirmCancel(false);
    } catch (err) {
      setCancelError(errorMessage(err, locale));
    }
  }

  return (
    <div className="space-y-4">
      <Link href="/purchases" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 5 }).map((_, i) => (
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

      {po && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold">{po.number}</h1>
              <PoStatusBadge status={po.status} />
            </div>
            <div className="flex flex-wrap gap-2">
              {canManage && po.status === 'DRAFT' && (
                <Button onClick={markOrdered} disabled={orderMutation.isPending}>
                  {t('detail.markOrdered')}
                </Button>
              )}
              {canReceive && (po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED') && (
                <Link href={`/purchases/receive?po=${po.id}`} className={buttonVariants({})}>
                  <PackagePlus className="mr-2 h-4 w-4" />
                  {t('newReceipt')}
                </Link>
              )}
              {canManage && (po.status === 'DRAFT' || po.status === 'ORDERED') && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setCancelError(null);
                    setConfirmCancel(true);
                  }}
                >
                  {t('detail.cancelOrder')}
                </Button>
              )}
            </div>
          </div>

          {actionError && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {actionError}
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-4">
              <Info label={t('supplier')} value={po.supplier.name} />
              <Info label={t('warehouse')} value={po.warehouse.name} />
              <Info label={t('expectedAt')} value={po.expectedAt ? formatDate(po.expectedAt, locale) : '—'} />
              <Info label={t('total')} value={`${formatMoney(po.totalAmount)} ${t('somUnit')}`} />
              {po.note && (
                <div className="sm:col-span-4">
                  <Info label={t('note')} value={po.note} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('detail.lines')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">{t('detail.product')}</th>
                      <th className="pb-2 pr-3 text-right font-medium">{t('detail.qty')}</th>
                      <th className="pb-2 pr-3 text-right font-medium">{t('detail.qtyReceived')}</th>
                      <th className="pb-2 pr-3 text-right font-medium">{t('detail.remaining')}</th>
                      <th className="pb-2 pr-3 text-right font-medium">{t('detail.unitPrice')}</th>
                      <th className="pb-2 text-right font-medium">{t('detail.lineTotal')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {po.lines.map((l) => {
                      const pct = Math.min(100, Math.round((Number(l.qtyReceived) / Number(l.qty)) * 100)) || 0;
                      return (
                        <tr key={l.id}>
                          <td className="py-2 pr-3">
                            <div className="font-medium">{l.productName}</div>
                            <div className="text-xs text-muted-foreground">{l.productSku}</div>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatQty(l.qty)} {l.unit}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            <div>{formatQty(l.qtyReceived)}</div>
                            <div
                              className="ml-auto mt-1 h-1.5 w-20 overflow-hidden rounded bg-muted"
                              role="progressbar"
                              aria-valuenow={pct}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={t('detail.qtyReceived')}
                            >
                              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatQty(remainingQty(l.qty, l.qtyReceived))}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(l.unitPrice)}</td>
                          <td className="py-2 text-right tabular-nums">{formatMoney(l.lineTotal)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('detail.receipts')}</CardTitle>
            </CardHeader>
            <CardContent>
              {po.goodsReceipts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('detail.noReceipts')}</p>
              ) : (
                <ul className="space-y-4">
                  {po.goodsReceipts.map((r) => (
                    <li key={r.id} className="rounded-md border border-border p-3">
                      <div className="text-sm font-medium">{formatDateTime(r.receivedAt, locale)}</div>
                      {r.note && <div className="text-xs text-muted-foreground">{r.note}</div>}
                      <ul className="mt-2 space-y-1 text-sm">
                        {r.lines.map((rl) => (
                          <li key={rl.id} className="flex justify-between gap-4">
                            <span>{rl.productName}</span>
                            <span className="tabular-nums">
                              {formatQty(rl.qty)} {rl.unit}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmCancel(false);
            setCancelError(null);
          }
        }}
        title={t('detail.confirmCancel.title')}
        description={t('detail.confirmCancel.description', { number: po?.number ?? '' })}
        confirmLabel={t('detail.cancelOrder')}
        error={cancelError}
        isPending={cancelMutation.isPending}
        onConfirm={cancel}
      />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
