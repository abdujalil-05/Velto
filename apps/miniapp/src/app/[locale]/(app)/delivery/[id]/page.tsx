'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MapPin, Phone, User as UserIcon } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useCourierOrdersQuery, useDeliverOrderMutation } from '@/lib/api/orders';
import { errorMessage } from '@/lib/api/client';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { formatDateTime, formatMoney } from '@/lib/format';
import { orderStatusVariant } from '@/components/courier/order-status';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';

/**
 * One assigned delivery + the "Delivered" action. Reads the order out of the
 * same courier list query rather than a per-id endpoint, so opening the screen
 * costs no extra round-trip and a reload re-fetches the list the courier came
 * from. Online-only: the deliver call goes straight to the API (no queue).
 */
export default function DeliveryDetailPage() {
  const t = useTranslations('Courier');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const orderId = params.id;

  useTelegramBackButton(useCallback(() => router.push('/'), [router]));

  const { user } = useAuth();
  const orders = useCourierOrdersQuery(user?.id);
  const deliver = useDeliverOrderMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const order = orders.data?.data.find((o) => o.id === orderId);
  const phone = order?.customer?.phone ?? null;
  const alreadyClosed = order ? ['DELIVERED', 'CLOSED', 'CANCELLED'].includes(order.status) : false;

  async function handleDeliver() {
    try {
      await deliver.mutateAsync(orderId);
      setConfirmOpen(false);
      toast.success(t('deliveredSuccess'));
      router.push('/');
    } catch (err) {
      toast.error(errorMessage(err, locale));
    }
  }

  if (orders.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (orders.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('loadError')}</AlertDescription>
      </Alert>
    );
  }

  if (!order) {
    return (
      <Alert>
        <AlertDescription>{t('notFound')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{t('orderNumber', { number: order.number })}</h1>
          <p className="text-xs text-muted-foreground">{formatDateTime(order.createdAt, locale)}</p>
        </div>
        <Badge variant={orderStatusVariant(order.status)}>{t(`status.${order.status}`)}</Badge>
      </div>

      <Card>
        <CardContent className="space-y-3 py-4 text-sm">
          <div className="flex items-start gap-3">
            <UserIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{t('customer')}</p>
              <p className="font-medium">{order.customer?.name ?? t('unknownCustomer')}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{t('address')}</p>
              <p className="font-medium">{order.outlet?.address ?? order.outlet?.name ?? t('noAddress')}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Phone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{t('phone')}</p>
              {phone ? (
                <a href={`tel:${phone}`} className="font-medium text-primary">
                  {phone}
                </a>
              ) : (
                <p className="font-medium">{t('noPhone')}</p>
              )}
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">{t('total')}</p>
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(order.total)} <span className="text-sm font-normal text-muted-foreground">{tCommon('somUnit')}</span>
            </p>
          </div>
        </CardContent>
      </Card>

      {alreadyClosed ? (
        <p className="text-center text-sm text-muted-foreground">{t('alreadyDelivered')}</p>
      ) : (
        <Button size="lg" className="w-full" onClick={() => setConfirmOpen(true)} disabled={deliver.isPending}>
          {t('markDelivered')}
        </Button>
      )}

      <ConfirmSheet
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('deliverConfirmTitle')}
        description={t('deliverConfirmDescription')}
        itemName={order.customer?.name ?? order.number}
        tone="default"
        confirmLabel={t('markDelivered')}
        onConfirm={handleDeliver}
      />
    </div>
  );
}
