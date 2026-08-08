'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ShoppingCart, Wallet, XCircle } from 'lucide-react';
import { useRouter, Link } from '@/i18n/navigation';
import { useOfflineCustomers, useOfflineOutlets } from '@/lib/offline/use-offline-data';
import { useLastOrderQuery } from '@/lib/api/orders';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { enqueue } from '@/lib/offline/queue';
import type { CreateVisitInput } from '@/lib/api/visits';
import { useGeolocation } from '@/lib/hooks/use-geolocation';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { distanceMeters, formatDate, formatMoney } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Button, buttonVariants } from '@/components/ui/button';
import { YandexMap } from '@/components/shared/yandex-map';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const GPS_RADIUS_M = 150;

export default function VisitPage() {
  const t = useTranslations('Visit');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const router = useRouter();
  const params = useParams<{ outletId: string }>();
  const outletId = params.outletId;

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
  const [noOrderDialogOpen, setNoOrderDialogOpen] = useState(false);
  const [noOrderReason, setNoOrderReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const outletHasCoords = outlet?.latitude != null && outlet?.longitude != null;
  const distance =
    geo.latitude != null && geo.longitude != null && outletHasCoords
      ? distanceMeters(geo.latitude, geo.longitude, Number(outlet!.latitude), Number(outlet!.longitude))
      : null;

  // Hard block (9.4-follow-up): a visit can't be logged without a live GPS
  // reading, and — when the outlet has registered coordinates — not from
  // outside the 150m radius either. No reason-based bypass anymore; an
  // outlet with no registered coordinates at all is a data-quality gap, not
  // the agent's fault, so it doesn't block (the server applies the same
  // rule — see visits.service.ts). The button just stays disabled and
  // re-enables itself automatically as `useGeolocation`'s live watch closes
  // the distance.
  const gpsUnknown = geo.latitude == null || geo.longitude == null;
  const gpsFar = distance != null && distance > GPS_RADIUS_M;
  const canProceed = !gpsUnknown && !gpsFar;

  const isLoading = outlets.isLoading || customers.isLoading;

  const buildVisitPayload = useCallback(
    (outcome: 'ORDERED' | 'NO_ORDER'): CreateVisitInput => ({
      outletId,
      startedAt: startedAtRef.current,
      endedAt: new Date().toISOString(),
      latitude: geo.latitude ?? Number(outlet?.latitude ?? 0),
      longitude: geo.longitude ?? Number(outlet?.longitude ?? 0),
      outcome,
      noOrderReason: outcome === 'NO_ORDER' ? noOrderReason.trim() || undefined : undefined,
      clientId: '',
    }),
    [outletId, geo.latitude, geo.longitude, outlet, noOrderReason],
  );

  async function handleOrder() {
    if (!canProceed) return;
    const search = new URLSearchParams({
      outletId,
      visitStartedAt: startedAtRef.current,
      visitLat: String(geo.latitude ?? outlet?.latitude ?? ''),
      visitLng: String(geo.longitude ?? outlet?.longitude ?? ''),
    });
    router.push(`/order/new?${search.toString()}`);
  }

  async function handleNoOrder() {
    if (!canProceed) return;
    setSubmitting(true);
    try {
      const payload = buildVisitPayload('NO_ORDER');
      await enqueue('visit', payload as unknown as Record<string, unknown>);
      syncEngine.notifyQueueChanged();
      setNoOrderDialogOpen(false);
      router.push('/route');
    } finally {
      setSubmitting(false);
    }
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

      {!canProceed && (
        <Alert variant="destructive">
          <AlertDescription>{gpsUnknown ? t('gpsUnknown') : t('gpsTooFar')}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-3 pt-2">
        <Button size="lg" className="w-full justify-start gap-3 text-base" disabled={!canProceed} onClick={handleOrder}>
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
          disabled={!canProceed}
          onClick={() => setNoOrderDialogOpen(true)}
        >
          <XCircle className="h-5 w-5" />
          {t('leaveNoOrder')}
        </Button>
      </div>

      <Dialog open={noOrderDialogOpen} onOpenChange={setNoOrderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('leaveNoOrder')}</DialogTitle>
            <DialogCloseButton onClick={() => setNoOrderDialogOpen(false)} />
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('noOrderReasonLabel')}</label>
            <Textarea
              value={noOrderReason}
              onChange={(e) => setNoOrderReason(e.target.value)}
              placeholder={t('noOrderReasonPlaceholder')}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoOrderDialogOpen(false)} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={handleNoOrder} disabled={submitting}>
              {tCommon('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
