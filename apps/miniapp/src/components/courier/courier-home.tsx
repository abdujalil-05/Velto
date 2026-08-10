'use client';

import { useTranslations } from 'next-intl';
import { PackageCheck } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useCourierOrdersQuery } from '@/lib/api/orders';
import { formatMoney } from '@/lib/format';
import { orderStatusVariant } from './order-status';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

/**
 * Courier home: the deliveries assigned to the signed-in courier, nothing else
 * (no routes, visits, order creation or payments — those stay agent-only).
 * Online-only by design; there is no offline cache or queue behind this screen.
 */
export function CourierHome() {
  const t = useTranslations('Courier');
  const tCommon = useTranslations('Common');
  const { user } = useAuth();

  const orders = useCourierOrdersQuery(user?.id);
  const rows = orders.data?.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t('title')}</h1>

      {orders.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {orders.isError && !orders.isLoading && (
        <Alert variant="destructive">
          <AlertDescription>{t('loadError')}</AlertDescription>
        </Alert>
      )}

      {!orders.isLoading && !orders.isError && rows.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <PackageCheck className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('emptyState')}</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {rows.map((order) => {
          const phone = order.customer?.phone ?? null;
          return (
            <Card key={order.id}>
              <CardContent className="py-3">
                <Link href={`/delivery/${order.id}`} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate font-medium">{order.customer?.name ?? t('unknownCustomer')}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t('orderNumber', { number: order.number })}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {order.outlet?.address ?? order.outlet?.name ?? t('noAddress')}
                    </p>
                    {phone && <p className="truncate text-xs text-muted-foreground">{phone}</p>}
                  </div>
                  <div className="shrink-0 space-y-1 text-right">
                    <p className="font-semibold tabular-nums">
                      {formatMoney(order.total)} <span className="text-xs font-normal text-muted-foreground">{tCommon('somUnit')}</span>
                    </p>
                    <Badge variant={orderStatusVariant(order.status)}>{t(`status.${order.status}`)}</Badge>
                  </div>
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
