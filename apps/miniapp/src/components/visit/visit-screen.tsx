'use client';

import { FreshnessLabel } from '@/components/freshness-label';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ShoppingCart, SkipForward, Wallet, XCircle } from 'lucide-react';
import { useRouter, Link } from '@/i18n/navigation';
import { useOfflineCustomers, useOfflineOutlets } from '@/lib/offline/use-offline-data';
import { useLastOrderQuery } from '@/lib/api/orders';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { ForeignLegacyBlockedError, VaultUnavailableError } from '@/lib/offline/vault';
import { enqueue, QueueQuotaError } from '@/lib/offline/queue';
import type { CreateVisitInput } from '@/lib/api/visits';
import { buildVisitGpsFields, localGpsStatus, stashVisitGps } from '@/lib/gps-payload';
import { useGeolocation } from '@/lib/hooks/use-geolocation';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { distanceMeters, formatDate, formatMoney } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Button, buttonVariants } from '@/components/ui/button';
import { YandexMap } from '@/components/shared/yandex-map';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';
import { cn } from '@/lib/utils';

export function VisitScreen({ outletId }: { outletId: string }) {
  const t = useTranslations('Visit');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const router = useRouter();

  useTelegramBackButton(useCallback(() => router.push('/route'), [router]));

  const outlets = useOfflineOutlets();
  const customers = useOfflineCustomers();
  const geo = useGeolocation();
  const syncEngine = useSyncEngine();

  const outlet = useMemo(() => outlets.data?.find((o) => o.id === outletId), [outlets.data, outletId]);
  const customer = useMemo(
    () => (outlet ? customers.data?.find((c) => c.id === outlet.customerId) : undefined),
    [customers.data, outlet],
  );

  const lastOrder = useLastOrderQuery(customer?.id ?? null);

  const startedAtRef = useRef(new Date().toISOString());
  // Created once per visit form: retries / double-clicks reuse it, the queue dedupes.
  const visitClientIdRef = useRef<string>('');
  if (!visitClientIdRef.current) visitClientIdRef.current = crypto.randomUUID();
  const savingRef = useRef(false);
  const [noOrderDialogOpen, setNoOrderDialogOpen] = useState(false);
  const [noOrderReason, setNoOrderReason] = useState('');
  const [skipDialogOpen, setSkipDialogOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');

  const outletHasCoords = outlet?.latitude != null && outlet?.longitude != null;
  const distance =
    geo.latitude != null && geo.longitude != null && outletHasCoords
      ? distanceMeters(geo.latitude, geo.longitude, Number(outlet!.latitude), Number(outlet!.longitude))
      : null;

  // The server decides the GPS status (radius, accuracy thresholds); the
  // client only reports what the device gave. Nothing blocks the visit: it is
  // always saved, and an unverified GPS result is surfaced as a warning.
  const gpsFields = useMemo(() => buildVisitGpsFields(geo), [geo]);
  const gpsHint = localGpsStatus(gpsFields, outletHasCoords);

  const isLoading = outlets.isLoading || customers.isLoading;

  const buildVisitPayload = useCallback(
    (outcome: 'NO_ORDER' | 'SKIPPED', reason: string): CreateVisitInput => ({
      outletId,
      startedAt: startedAtRef.current,
      endedAt: new Date().toISOString(),
      ...gpsFields,
      outcome,
      ...(outcome === 'NO_ORDER' ? { noOrderReason: reason.trim() || undefined } : { skipReason: reason.trim() }),
      clientId: '',
    }),
    [outletId, gpsFields],
  );

  async function handleOrder() {
    const search = new URLSearchParams({ outletId, visitStartedAt: startedAtRef.current });
    stashVisitGps(outletId, gpsFields);
    router.push(`/order/new?${search.toString()}`);
  }

  // Closing a visit is not undoable from the device: the moment `enqueue`
  // resolves the document is durable in IndexedDB and owned by the queue.
  // "Saved on device" is not "accepted by server" — the toast says so.
  async function saveClosedVisit(outcome: 'NO_ORDER' | 'SKIPPED', reason: string): Promise<boolean> {
    if (savingRef.current) return false;
    savingRef.current = true;
    try {
      await enqueue('visit', buildVisitPayload(outcome, reason) as unknown as Record<string, unknown>, { clientId: visitClientIdRef.current });
    } catch (err) {
      // Never shown as success; dialog and entered reason stay so the agent can retry.
      toast.error(err instanceof VaultUnavailableError ? t('vaultBlocked') : err instanceof ForeignLegacyBlockedError ? t('foreignLegacyBlocked') : err instanceof QueueQuotaError ? t('saveQuotaFull') : t('saveFailed'));
      return false;
    } finally {
      savingRef.current = false;
    }
    // Written: the next visit document on this instance gets a fresh id; later errors are not save failures.
    visitClientIdRef.current = crypto.randomUUID();
    try {
      syncEngine.notifyQueueChanged();
      toast.success(t('savedOnDevice'));
      if (gpsHint) toast.warning(t(`gpsStatus.${gpsHint}`));
      router.push('/route');
    } catch {
      /* document is already saved on device; navigation/toast problems must not look like a failed save */
    }
    return true;
  }

  async function handleNoOrder() {
    if (await saveClosedVisit('NO_ORDER', noOrderReason)) setNoOrderDialogOpen(false);
  }

  async function handleSkip() {
    if (!skipReason.trim()) return;
    if (await saveClosedVisit('SKIPPED', skipReason)) setSkipDialogOpen(false);
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (!outlet || !customer) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('notFound')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">{customer.name}</h1>
        <p className="text-sm text-muted-foreground">{outlet.name}</p>
      </div>

      <Card>
        <CardContent className="space-y-2 py-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('currentDebt')}</p>
          <p className={cn('text-2xl font-bold tabular-nums', Number(customer.cachedBalance) > 0 && 'text-destructive')}>
            {formatMoney(customer.cachedBalance)} {tCommon('somUnit')}
          </p>
          <FreshnessLabel dataset="balances" />
          <p className="text-xs text-muted-foreground">
            {t('lastOrder')}:{' '}
            {lastOrder.isLoading ? '…' : lastOrder.data ? formatDate(lastOrder.data.createdAt, locale) : t('never')}
          </p>
        </CardContent>
      </Card>

      <YandexMap
        outletLat={outletHasCoords ? Number(outlet.latitude) : null}
        outletLng={outletHasCoords ? Number(outlet.longitude) : null}
        agentLat={geo.latitude}
        agentLng={geo.longitude}
        className="overflow-hidden rounded-md border border-border"
      />

      {distance != null && (
        <p className="text-xs text-muted-foreground">
          {t('distance')}: {Math.round(distance)} {t('metersShort')}
        </p>
      )}

      {geo.accuracyM != null && (
        <p className="text-xs text-muted-foreground">
          {t('accuracy')}: ±{Math.round(geo.accuracyM)} {t('metersShort')}
        </p>
      )}

      {gpsHint && (
        <Alert>
          <AlertDescription>{geo.loading ? t('gpsUnknown') : t(`gpsStatus.${gpsHint}`)}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-3 pt-2">
        <Button size="lg" className="w-full justify-start gap-3 text-base" onClick={handleOrder}>
          <ShoppingCart className="h-5 w-5" />
          {t('takeOrder')}
        </Button>
        <Link
          href={`/payment/new?customerId=${customer.id}`}
          className={cn(buttonVariants({ size: 'lg', variant: 'secondary' }), 'w-full justify-start gap-3 text-base')}
        >
          <Wallet className="h-5 w-5" />
          {t('collectPayment')}
        </Link>
        <Button
          size="lg"
          variant="outline"
          className="w-full justify-start gap-3 text-base"
          onClick={() => setNoOrderDialogOpen(true)}
        >
          <XCircle className="h-5 w-5" />
          {t('leaveNoOrder')}
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full justify-start gap-3 text-base"
          onClick={() => setSkipDialogOpen(true)}
        >
          <SkipForward className="h-5 w-5" />
          {t('skipVisit')}
        </Button>
      </div>

      <ConfirmSheet
        open={noOrderDialogOpen}
        onOpenChange={setNoOrderDialogOpen}
        title={t('noOrderConfirmTitle')}
        description={t('noOrderConfirmDescription')}
        itemName={`${customer.name} · ${outlet.name}`}
        queued
        confirmLabel={t('noOrderConfirmAction')}
        onConfirm={handleNoOrder}
      >
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('noOrderReasonLabel')}</label>
          <Textarea
            value={noOrderReason}
            onChange={(e) => setNoOrderReason(e.target.value)}
            placeholder={t('noOrderReasonPlaceholder')}
            rows={2}
          />
        </div>
      </ConfirmSheet>

      <ConfirmSheet
        open={skipDialogOpen}
        onOpenChange={setSkipDialogOpen}
        title={t('skipConfirmTitle')}
        description={t('skipConfirmDescription')}
        itemName={`${customer.name} · ${outlet.name}`}
        queued
        confirmLabel={t('skipConfirmAction')}
        onConfirm={handleSkip}
        confirmDisabled={!skipReason.trim()}
      >
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('skipReasonLabel')}</label>
          <Textarea
            value={skipReason}
            onChange={(e) => setSkipReason(e.target.value)}
            placeholder={t('skipReasonPlaceholder')}
            rows={2}
            required
          />
          {!skipReason.trim() && <p className="text-xs text-destructive">{t('skipReasonRequired')}</p>}
        </div>
      </ConfirmSheet>
    </div>
  );
}
