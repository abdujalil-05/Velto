'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, PackageCheck, Ban, XCircle } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useOrderQuery,
  useConfirmOrderMutation,
  useDeliverOrderMutation,
  useCloseOrderMutation,
  useCancelOrderMutation,
} from '@/lib/api/orders';
import { errorMessage } from '@/lib/api/client';
import { formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { OrderStatusBadge } from '@/components/shared/order-status-badge';
import { CancelOrderDialog } from '@/components/orders/cancel-order-dialog';

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Orders.detail');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();

  const { data: order, isLoading, isError, error, refetch } = useOrderQuery(id);
  const confirmMutation = useConfirmOrderMutation(id);
  const deliverMutation = useDeliverOrderMutation(id);
  const closeMutation = useCloseOrderMutation(id);
  const cancelMutation = useCancelOrderMutation(id);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !order) {
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

  const canUpdate = hasPermission('orders.update');
  const canCancel = hasPermission('orders.cancel');

  const canConfirm = canUpdate && order.status === 'SUBMITTED';
  // CONFIRMED -> DELIVERED is the normal path; SHIPPED -> DELIVERED is for orders handed to a
  // deliverer supplier (created with supplierId, or assigned one later) — see sales.service.ts deliver().
  const canDeliver = canUpdate && (order.status === 'CONFIRMED' || order.status === 'SHIPPED');
  const canClose = canUpdate && order.status === 'DELIVERED';
  const canCancelOrder = canCancel && !['DELIVERED', 'CLOSED', 'CANCELLED'].includes(order.status);

  return (
    <div className="space-y-4">
      <Link href="/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{order.number}</h1>
            <OrderStatusBadge status={order.status} />
          </div>
          <p className="text-sm text-muted-foreground">{formatDateTime(order.createdAt, locale)}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canConfirm && (
            <Button
              size="sm"
              onClick={() =>
                confirmMutation.mutate(undefined, {
                  onSuccess: () => toast.success(t('confirmSuccess')),
                  onError: (err) => toast.error(errorMessage(err, locale)),
                })
              }
              disabled={confirmMutation.isPending}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {t('confirm')}
            </Button>
          )}
          {canDeliver && (
            <Button
              size="sm"
              onClick={() =>
                deliverMutation.mutate(undefined, {
                  onSuccess: () => toast.success(t('deliverSuccess')),
                  onError: (err) => toast.error(errorMessage(err, locale)),
                })
              }
              disabled={deliverMutation.isPending}
            >
              <PackageCheck className="mr-2 h-4 w-4" />
              {t('deliver')}
            </Button>
          )}
          {canClose && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                closeMutation.mutate(undefined, {
                  onSuccess: () => toast.success(t('closeSuccess')),
                  onError: (err) => toast.error(errorMessage(err, locale)),
                })
              }
              disabled={closeMutation.isPending}
            >
              <XCircle className="mr-2 h-4 w-4" />
              {t('close')}
            </Button>
          )}
          {canCancelOrder && (
            <Button size="sm" variant="destructive" onClick={() => setCancelDialogOpen(true)}>
              <Ban className="mr-2 h-4 w-4" />
              {t('cancel')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <InfoCard label={t('customer')} value={order.customer.name} />
        <InfoCard label={t('outlet')} value={order.outlet?.name} />
        <InfoCard label={t('agent')} value={order.agent ? `${order.agent.firstName} ${order.agent.lastName}` : t('noAgent')} />
        <InfoCard label={t('warehouse')} value={order.warehouse.name} />
        {order.deliverySupplier && <InfoCard label={t('deliverer')} value={order.deliverySupplier.name} />}
      </div>

      {order.note && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('note')}</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">{order.note}</CardContent>
        </Card>
      )}

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
                  <th className="pb-2 pr-3 font-medium">{t('packaging')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('qty')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('unitPrice')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('discount')}</th>
                  <th className="pb-2 text-right font-medium">{t('lineTotal')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {order.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-2 pr-3">{line.product.name}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{line.packaging.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatQty(line.qty)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(line.unitPrice)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{Number(line.discountPct) > 0 ? `${line.discountPct}%` : '—'}</td>
                    <td className="py-2 text-right tabular-nums font-medium">{formatMoney(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td colSpan={5} className="py-2 pr-3 text-right text-sm font-medium">
                    {t('orderTotal')}
                  </td>
                  <td className="py-2 text-right text-base font-semibold tabular-nums">
                    {formatMoney(order.total)} <span className="text-sm text-muted-foreground">{tCommon('somUnit')}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      <CancelOrderDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        isSubmitting={cancelMutation.isPending}
        onConfirm={(reason) =>
          cancelMutation.mutate(reason, {
            onSuccess: () => {
              toast.success(t('cancelSuccess'));
              setCancelDialogOpen(false);
            },
            onError: (err) => toast.error(errorMessage(err, locale)),
          })
        }
      />
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value?: string | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm font-medium">{value || '—'}</p>
      </CardContent>
    </Card>
  );
}
