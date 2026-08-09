'use client';

import { useCallback, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Circle, Flag, MapPin, Wallet } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useRouter } from '@/i18n/navigation';
import {
  useOfflineCustomers,
  useOfflineOutlets,
  useOfflineRouteStops,
  useOfflineRoutes,
  useOfflineTodayQueue,
} from '@/lib/offline/use-offline-data';
import type { CreateVisitInput } from '@/lib/api/visits';
import { useFinishRouteMutation } from '@/lib/api/routes';
import { errorMessage } from '@/lib/api/client';
import { useGeolocation } from '@/lib/hooks/use-geolocation';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { distanceMeters, formatDate, formatMoney, formatWeekday, isoWeekday } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';

export default function RoutePage() {
  const t = useTranslations('Route');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const router = useRouter();
  const geo = useGeolocation();
  const finishRoute = useFinishRouteMutation();

  useTelegramBackButton(useCallback(() => router.push('/'), [router]));

  const routes = useOfflineRoutes();
  const routeStops = useOfflineRouteStops();
  const outlets = useOfflineOutlets();
  const customers = useOfflineCustomers();
  const visitsToday = useOfflineTodayQueue('visit');

  const [finishedRouteIds, setFinishedRouteIds] = useState<Set<string>>(new Set());
  const [finishingId, setFinishingId] = useState<string | null>(null);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);

  const today = useMemo(() => new Date(), []);

  const { stops, todaysRouteIds } = useMemo(() => {
    if (!routes.data || !routeStops.data || !outlets.data || !customers.data) return { stops: [], todaysRouteIds: [] as string[] };
    const weekday = isoWeekday(today);
    const todaysRoutes = routes.data.filter((r) => r.weekday === weekday);
    const todaysRouteIdSet = new Set(todaysRoutes.map((r) => r.id));
    const outletById = new Map(outlets.data.map((o) => [o.id, o]));
    const customerById = new Map(customers.data.map((c) => [c.id, c]));
    const visitedOutletIds = new Set(
      (visitsToday.data ?? []).map((entry) => (entry.payload as unknown as CreateVisitInput).outletId),
    );

    const list = routeStops.data
      .filter((stop) => todaysRouteIdSet.has(stop.routeId))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((stop) => {
        const outlet = outletById.get(stop.outletId);
        const customer = outlet ? customerById.get(outlet.customerId) : undefined;
        const distance =
          geo.latitude != null && geo.longitude != null && outlet?.latitude != null && outlet?.longitude != null
            ? distanceMeters(geo.latitude, geo.longitude, Number(outlet.latitude), Number(outlet.longitude))
            : null;
        return {
          stopId: stop.id,
          routeId: stop.routeId,
          outletId: stop.outletId,
          customerId: customer?.id ?? null,
          outletName: outlet?.name ?? '—',
          customerName: customer?.name ?? '—',
          balance: customer ? Number(customer.cachedBalance) : 0,
          distance,
          visited: visitedOutletIds.has(stop.outletId),
        };
      });
    return { stops: list, todaysRouteIds: [...todaysRouteIdSet] };
  }, [routes.data, routeStops.data, outlets.data, customers.data, visitsToday.data, geo.latitude, geo.longitude, today]);

  const allVisited = stops.length > 0 && stops.every((s) => s.visited);
  const pendingRouteIds = todaysRouteIds.filter((id) => !finishedRouteIds.has(id));
  const canFinish = allVisited && pendingRouteIds.length > 0;

  // Closing the run is a server-side one-way door (no reopen endpoint for an
  // agent) and, unlike orders/visits/payments, it is NOT queueable — it goes
  // straight to the API, so a partial failure mid-loop can leave one route of
  // the day closed and another open. Worth an explicit confirmation.
  async function handleFinish() {
    setFinishingId('*');
    try {
      for (const routeId of pendingRouteIds) {
        await finishRoute.mutateAsync(routeId);
      }
      setFinishedRouteIds((prev) => new Set([...prev, ...pendingRouteIds]));
      setFinishConfirmOpen(false);
      toast.success(t('finishSuccess'));
    } catch (err) {
      toast.error(errorMessage(err, locale));
    } finally {
      setFinishingId(null);
    }
  }

  const isLoading = routes.isLoading || routeStops.isLoading || outlets.isLoading || customers.isLoading;
  const isError = routes.isError || routeStops.isError || outlets.isError || customers.isError;
  const isFinished = todaysRouteIds.length > 0 && pendingRouteIds.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <p className="text-sm capitalize text-muted-foreground">
          {formatWeekday(today, locale)}, {formatDate(today, locale)}
        </p>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {isError && !isLoading && (
        <Alert variant="destructive">
          <AlertDescription>{t('loadError')}</AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && stops.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <MapPin className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('emptyState')}</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {stops.map((stop) => (
          <Card key={stop.stopId} className="transition-colors">
            <CardContent className="flex items-center gap-3 py-3">
              <Link href={`/visit/${stop.outletId}`} className="flex min-w-0 flex-1 items-center gap-3">
                {stop.visited ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                ) : (
                  <Circle className="h-5 w-5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{stop.customerName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {stop.outletName}
                    {stop.distance != null && ` · ${Math.round(stop.distance)} ${t('metersShort')}`}
                  </p>
                </div>
              </Link>
              {stop.balance > 0 && (
                <Link
                  href={`/payment/new?customerId=${stop.customerId}`}
                  className="flex shrink-0 flex-col items-end gap-0.5"
                  aria-label={t('collectPayment')}
                >
                  <span className="flex items-center gap-1 text-sm font-semibold tabular-nums text-destructive">
                    <Wallet className="h-3.5 w-3.5" />
                    {formatMoney(stop.balance)} {tCommon('somUnit')}
                  </span>
                </Link>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {allVisited && (
        <Button
          size="lg"
          className="w-full gap-2"
          disabled={!canFinish || finishingId !== null}
          onClick={() => setFinishConfirmOpen(true)}
        >
          <Flag className="h-4 w-4" />
          {isFinished ? t('finished') : t('finishRoute')}
        </Button>
      )}

      <ConfirmSheet
        open={finishConfirmOpen}
        onOpenChange={setFinishConfirmOpen}
        title={t('finishConfirmTitle')}
        description={t('finishConfirmDescription', { count: stops.length })}
        tone="default"
        confirmLabel={t('finishRoute')}
        onConfirm={handleFinish}
      />
    </div>
  );
}
