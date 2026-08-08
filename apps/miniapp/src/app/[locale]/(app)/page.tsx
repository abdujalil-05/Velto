'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart3, Route as RouteIcon, ShoppingCart } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useOfflineCustomers,
  useOfflineDefaultPriceListId,
  useOfflinePackagings,
  useOfflinePrices,
  useOfflineProducts,
  useOfflineRouteStops,
  useOfflineRoutes,
  useOfflineTodayQueue,
} from '@/lib/offline/use-offline-data';
import { estimateOrderTotal } from '@/lib/offline/pricing';
import type { CreateOrderInput } from '@/lib/api/orders';
import type { CreatePaymentInput } from '@/lib/api/payments';
import { formatMoney, isoWeekday } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function HomePage() {
  const t = useTranslations('Home');
  const tCommon = useTranslations('Common');
  const { user } = useAuth();

  const routes = useOfflineRoutes();
  const routeStops = useOfflineRouteStops();
  const visitsToday = useOfflineTodayQueue('visit');
  const ordersToday = useOfflineTodayQueue('order');
  const paymentsToday = useOfflineTodayQueue('payment');
  const customers = useOfflineCustomers();
  const products = useOfflineProducts();
  const packagings = useOfflinePackagings();
  const prices = useOfflinePrices();
  const defaultPriceListId = useOfflineDefaultPriceListId();

  const totalStopsToday = useMemo(() => {
    if (!routes.data || !routeStops.data) return null;
    const weekday = isoWeekday(new Date());
    const todaysRouteIds = new Set(routes.data.filter((r) => r.weekday === weekday).map((r) => r.id));
    return routeStops.data.filter((stop) => todaysRouteIds.has(stop.routeId)).length;
  }, [routes.data, routeStops.data]);

  // 9.4 Ekran 1: estimated from today's queued orders (pending or already
  // synced) rather than a network call — this is what makes the figure
  // available offline. The server's confirmed total can differ slightly
  // (rounding, a price that changed server-side per 10.4) — an honest
  // trade-off for a number that must work with no connection at all.
  const turnoverToday = useMemo(() => {
    if (!ordersToday.data || !customers.data || !products.data || !packagings.data || !prices.data || defaultPriceListId.data === undefined) {
      return null;
    }
    return ordersToday.data.reduce((sum, entry) => {
      const payload = entry.payload as unknown as CreateOrderInput;
      const customer = customers.data.find((c) => c.id === payload.customerId);
      return (
        sum +
        estimateOrderTotal(
          payload.lines,
          customer?.priceListId ?? null,
          defaultPriceListId.data,
          products.data,
          packagings.data,
          prices.data,
        )
      );
    }, 0);
  }, [ordersToday.data, customers.data, products.data, packagings.data, prices.data, defaultPriceListId.data]);

  const collectedToday = useMemo(() => {
    if (!paymentsToday.data) return null;
    return paymentsToday.data.reduce((sum, entry) => sum + Number((entry.payload as unknown as CreatePaymentInput).amount), 0);
  }, [paymentsToday.data]);

  const isLoading = routes.isLoading || routeStops.isLoading || visitsToday.isLoading || ordersToday.isLoading || paymentsToday.isLoading;
  const isError = routes.isError || routeStops.isError || visitsToday.isError || ordersToday.isError || paymentsToday.isError;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">{t('greeting', { name: user?.firstName ?? '' })}</h1>

      <Card>
        <CardContent className="space-y-3 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('today')}</p>

          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-6 w-1/2" />
            </div>
          )}

          {isError && !isLoading && (
            <Alert variant="destructive">
              <AlertDescription>{t('loadError')}</AlertDescription>
            </Alert>
          )}

          {!isLoading && !isError && (
            <div className="space-y-1">
              <p className="text-2xl font-bold tabular-nums">
                {visitsToday.data?.length ?? 0} / {totalStopsToday ?? 0}{' '}
                <span className="text-sm font-normal text-muted-foreground">{t('stops')}</span>
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {formatMoney(turnoverToday ?? 0)} <span className="text-sm text-muted-foreground">{tCommon('somUnit')}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t('collected')}:{' '}
                <span className="font-medium tabular-nums text-success">
                  {formatMoney(collectedToday ?? 0)} {tCommon('somUnit')}
                </span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 9.4 "Bosh ekranda faqat 3 element" — route, new order, daily result. */}
      <div className="space-y-3">
        <Link href="/route" className={cn(buttonVariants({ size: 'lg' }), 'w-full justify-start gap-3 text-base')}>
          <RouteIcon className="h-5 w-5" />
          {t('routeAction')}
        </Link>
        <Link href="/order/new" className={cn(buttonVariants({ size: 'lg', variant: 'secondary' }), 'w-full justify-start gap-3 text-base')}>
          <ShoppingCart className="h-5 w-5" />
          {t('orderAction')}
        </Link>
        <Link href="/report" className={cn(buttonVariants({ size: 'lg', variant: 'outline' }), 'w-full justify-start gap-3 text-base')}>
          <BarChart3 className="h-5 w-5" />
          {t('reportAction')}
        </Link>
      </div>
    </div>
  );
}
