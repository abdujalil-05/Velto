'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Ban, PackageCheck, Send } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import {
  usePurchaseOrderQuery,
  useSubmitPurchaseOrderMutation,
  useReceivePurchaseOrderMutation,
  useCancelPurchaseOrderMutation,
} from '@/lib/api/purchase-orders';
import { errorMessage } from '@/lib/api/client';
import { formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PurchaseOrderStatusBadge } from '@/components/purchases/purchase-order-status-badge';
import { ReceivePurchaseOrderDialog } from '@/components/purchases/receive-purchase-order-dialog';

export default function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Purchases.detail');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();

  const { data: po, isLoading, isError, error, refetch } = usePurchaseOrderQuery(id);
  const submitMutation = useSubmitPurchaseOrderMutation(id);
  const receiveMutation = useReceivePurchaseOrderMutation(id);
  const cancelMutation = useCancelPurchaseOrderMutation(id);
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !po) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{error ? errorMessage(error, locale) : t('notFound')}</span>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const canUpdate = hasPermission('purchases.update');
  const canReceive = hasPermission('purchases.receive');
  const canSubmit = canUpdate && po.status === 'DRAFT';
  const canReceiveOrder = canReceive && (po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED');
  const canCancel = canUpdate && (po.status === 'DRAFT' || po.status === 'ORDERED');

  const total = po.lines.reduce((sum, l) => sum + Number(l.qty) * Number(l.unitPrice), 0);

  return (
    <div className="space-y-4">
      <Link href="/purchases" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{po.number}</h1>
            <PurchaseOrderStatusBadge status={po.status} />
          </div>
          <p className="text-sm text-muted-foreground">{formatDateTime(po.createdAt, locale)}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canSubmit && (
            <Button
              size="sm"
              onClick={() =>
                submitMutation.mutate(undefined, {
                  onSuccess: () => toast.success(t('submitSuccess')),
                  onError: (err) => toast.error(errorMessage(err, locale)),
                })
              }
              disabled={submitMutation.isPending}
            >
              <Send className="mr-2 h-4 w-4" />
              {t('submit')}
            </Button>
          )}
          {canReceiveOrder && (
            <Button size="sm" onClick={() => setReceiveDialogOpen(true)}>
              <PackageCheck className="mr-2 h-4 w-4" />
              {t('receive')}
            </Button>
          )}
          {canCancel && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                cancelMutation.mutate(undefined, {
                  onSuccess: () => toast.success(t('cancelSuccess')),
                  onError: (err) => toast.error(errorMessage(err, locale)),
                })
              }
              disabled={cancelMutation.isPending}
            >
              <Ban className="mr-2 h-4 w-4" />
              {t('cancel')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <InfoCard label={t('supplier')} value={po.supplier.name} />
        <InfoCard label={t('warehouse')} value={po.warehouse.name} />
        {po.note && <InfoCard label={t('note')} value={po.note} />}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('lines')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">{t('product')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('qty')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('qtyReceived')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('unitPrice')}</th>
                  <th className="pb-2 text-right font-medium">{t('lineTotal')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {po.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-2 pr-3">{line.product.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatQty(line.qty)} <span className="text-xs text-muted-foreground">{line.product.baseUnit}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{formatQty(line.qtyReceived)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(line.unitPrice)}</td>
                    <td className="py-2 text-right tabular-nums font-medium">
                      {formatMoney(Number(line.qty) * Number(line.unitPrice))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td colSpan={4} className="py-2 pr-3 text-right text-sm font-medium">
                    {t('orderTotal')}
                  </td>
                  <td className="py-2 text-right text-base font-semibold tabular-nums">
                    {formatMoney(total)} <span className="text-sm text-muted-foreground">{tCommon('somUnit')}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      <ReceivePurchaseOrderDialog
        open={receiveDialogOpen}
        onOpenChange={setReceiveDialogOpen}
        purchaseOrder={po}
        isSubmitting={receiveMutation.isPending}
        onConfirm={(lines) =>
          receiveMutation.mutate(lines, {
            onSuccess: () => {
              toast.success(t('receiveSuccess'));
              setReceiveDialogOpen(false);
            },
            onError: (err) => toast.error(errorMessage(err, locale)),
          })
        }
      />
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm font-medium">{value}</p>
      </CardContent>
    </Card>
  );
}
