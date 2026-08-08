'use client';

import { useCallback, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  useOfflineCustomers,
  useOfflineDefaultPriceListId,
  useOfflinePackagings,
  useOfflinePrices,
  useOfflineProducts,
  useOfflineTodayQueue,
} from '@/lib/offline/use-offline-data';
import { estimateOrderTotal } from '@/lib/offline/pricing';
import type { CreateOrderInput } from '@/lib/api/orders';
import type { CreatePaymentInput } from '@/lib/api/payments';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { useRouter } from '@/i18n/navigation';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import type { QueueEntry, QueueStatus } from '@/lib/offline/queue';

const QUEUE_STATUS_VARIANT: Record<QueueStatus, 'default' | 'secondary' | 'destructive'> = {
  PENDING: 'secondary',
  SYNCED: 'default',
  FAILED: 'destructive',
};

export default function DailyReportPage() {
  const t = useTranslations('Report');
  const tQueue = useTranslations('Common.queueStatus');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const router = useRouter();

  useTelegramBackButton(useCallback(() => router.push('/'), [router]));

  const orders = useOfflineTodayQueue('order');
  const payments = useOfflineTodayQueue('payment');
  const customers = useOfflineCustomers();
  const products = useOfflineProducts();
  const packagings = useOfflinePackagings();
  const prices = useOfflinePrices();
  const defaultPriceListId = useOfflineDefaultPriceListId();

  const isReady = !!customers.data && !!products.data && !!packagings.data && !!prices.data && defaultPriceListId.data !== undefined;

  const orderRows = useMemo(() => {
    if (!orders.data || !isReady) return [];
    return orders.data
      .map((entry: QueueEntry) => {
        const payload = entry.payload as unknown as CreateOrderInput;
        const customer = customers.data!.find((c) => c.id === payload.customerId);
        const total = estimateOrderTotal(
          payload.lines,
          customer?.priceListId ?? null,
          defaultPriceListId.data!,
          products.data!,
          packagings.data!,
          prices.data!,
        );
        return { clientId: entry.clientId, status: entry.status, createdAt: entry.createdAt, customerName: customer?.name ?? '—', total };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [orders.data, isReady, customers.data, products.data, packagings.data, prices.data, defaultPriceListId.data]);

  const paymentRows = useMemo(() => {
    if (!payments.data || !customers.data) return [];
    return payments.data
      .map((entry: QueueEntry) => {
        const payload = entry.payload as unknown as CreatePaymentInput;
        const customer = customers.data!.find((c) => c.id === payload.customerId);
        return {
          clientId: entry.clientId,
          status: entry.status,
          createdAt: entry.createdAt,
          customerName: customer?.name ?? '—',
          amount: Number(payload.amount),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [payments.data, customers.data]);

  const isLoading = orders.isLoading || payments.isLoading || !isReady;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t('title')}</h1>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">{t('orders')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {!isLoading && orderRows.length === 0 && <p className="text-sm text-muted-foreground">{t('noOrders')}</p>}
          {orderRows.map((order) => (
            <div key={order.clientId} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0">
              <div className="min-w-0">
                <p className="truncate font-medium">{order.customerName}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(order.createdAt, locale)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums">
                  {formatMoney(order.total)} {tCommon('somUnit')}
                </p>
                <Badge variant={QUEUE_STATUS_VARIANT[order.status as QueueStatus]}>{tQueue(order.status)}</Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">{t('payments')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {!isLoading && paymentRows.length === 0 && <p className="text-sm text-muted-foreground">{t('noPayments')}</p>}
          {paymentRows.map((payment) => (
            <div key={payment.clientId} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0">
              <div className="min-w-0">
                <p className="truncate font-medium">{payment.customerName}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(payment.createdAt, locale)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums text-success">
                  {formatMoney(payment.amount)} {tCommon('somUnit')}
                </p>
                <Badge variant={QUEUE_STATUS_VARIANT[payment.status as QueueStatus]}>{tQueue(payment.status)}</Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
