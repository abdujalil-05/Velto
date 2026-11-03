'use client';

import { FreshnessLabel } from '@/components/freshness-label';
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
import { openStopsFrom, useFinishRouteMutation, useSkipStopMutation, type OpenRouteStop } from '@/lib/api/routes';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/auth-context';
import { Textarea } from '@/components/ui/textarea';
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
  const skipStop = useSkipStopMutation();
  const { hasPermission } = useAuth();
  const canFinishPerm = hasPermission('routes.finish');

  useTelegramBackButton(useCallback(() => router.push('/'), [router]));

  const routes = useOfflineRoutes();
  const routeStops = useOfflineRouteStops();
  const outlets = useOfflineOutlets();
  const customers = useOfflineCustomers();
  const visitsToday = useOfflineTodayQueue('visit');

  const [finishedRouteIds, setFinishedRouteIds] = useState<Set<string>>(new Set());
  const [finishingId, setFinishingId] = useState<string | null>(null);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [openStops, setOpenStops] = useState<(OpenRouteStop & { routeId: string })[]>([]);
  const [skipTarget, setSkipTarget] = useState<(OpenRouteStop & { routeId: string }) | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const [notOwned, setNotOwned] = useState(false);

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

  const pendingRouteIds = todaysRouteIds.filter((id) => !finishedRouteIds.has(id));
  // The server decides readiness (GPS-verified visit or skip with a reason); the button is shown by permission, not by the local visited count.
  const canFinish = pendingRouteIds.length > 0;

  // Closing the run is a server-side one-way door (no reopen endpoint for an
  // agent) and, unlike orders/visits/payments, it is NOT queueable — it goes
  // straight to the API, so a partial failure mid-loop can leave one route of
  // the day closed and another open. Worth an explicit confirmation.
  async function handleFinish() {
    setFinishingId('*');
    setNotOwned(false);
    const collected: (OpenRouteStop & { routeId: string })[] = [];
    const done: string[] = [];
    try {
      for (const routeId of pendingRouteIds) {
        try {
          await finishRoute.mutateAsync(routeId);
          done.push(routeId);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'ROUTE_NOT_READY') {
            collected.push(...openStopsFrom(err.details).map((s) => ({ ...s, routeId })));
          } else {
            throw err;
          }
        }
      }
      if (done.length > 0) setFinishedRouteIds((prev) => new Set([...prev, ...done]));
      setOpenStops(collected);
      setFinishConfirmOpen(false);
      if (collected.length === 0) toast.success(t('finishSuccess'));
      else toast.error(t('finishNotReady'));
    } catch (err) {
      if (done.length > 0) setFinishedRouteIds((prev) => new Set([...prev, ...done]));
      if (err instanceof ApiError && err.code === 'ROUTE_NOT_OWNED') setNotOwned(true);
      else toast.error(errorMessage(err, locale));
      setFinishConfirmOpen(false);
    } finally {
      setFinishingId(null);
    }
  }

  async function handleSkipStop() {
    if (!skipTarget || !skipReason.trim()) return;
    try {
      await skipStop.mutateAsync({ routeId: skipTarget.routeId, outletId: skipTarget.outletId, reason: skipReason.trim() });
      setOpenStops((prev) => prev.filter((s) => !(s.routeId === skipTarget.routeId && s.outletId === skipTarget.outletId)));
      toast.success(t('skipSuccess'));
      setSkipTarget(null);
      setSkipReason('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ROUTE_NOT_OWNED') setNotOwned(true);
      else toast.error(errorMessage(err, locale));
      setSkipTarget(null);
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

      <FreshnessLabel dataset="route" />
      <FreshnessLabel dataset="balances" />
      <div className="space-y-2">
        {stops.map((stop) => (
          <Card key={stop.stopId} className="transition-colors">
            <CardContent className="flex items-center gap-3 py-3">
              <Link href={{ pathname: '/visit', query: { outletId: stop.outletId } }} className="flex min-w-0 flex-1 items-center gap-3">
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

      {notOwned && (
        <Alert variant="destructive">
          <AlertDescription>{t('notOwned')}</AlertDescription>
        </Alert>
      )}

      {openStops.length > 0 && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <p className="text-sm font-medium">{t('openStopsTitle')}</p>
            {openStops.map((s) => (
              <div key={`${s.routeId}:${s.outletId}`} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.outletName}</p>
                  <p className="text-xs text-muted-foreground">{t.has(`openReason.${s.reason}`) ? t(`openReason.${s.reason}`) : s.reason}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setSkipTarget(s)}>
                  {t('skipStop')}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {canFinishPerm && stops.length > 0 && (
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
        open={skipTarget !== null}
        onOpenChange={(o) => {
          if (!o) setSkipTarget(null);
        }}
        title={t('skipConfirmTitle')}
        description={skipTarget?.outletName ?? ''}
        tone="default"
        confirmLabel={t('skipStop')}
        confirmDisabled={!skipReason.trim()}
        onConfirm={handleSkipStop}
      >
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('skipReasonLabel')}</label>
          <Textarea value={skipReason} onChange={(e) => setSkipReason(e.target.value)} rows={2} required />
          {!skipReason.trim() && <p className="text-xs text-destructive">{t('skipReasonRequired')}</p>}
        </div>
      </ConfirmSheet>

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
