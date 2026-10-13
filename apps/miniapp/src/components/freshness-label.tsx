'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { useOfflineLastPullAt } from '@/lib/offline/use-offline-data';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Older than this the cached stock/balance is shown as a warning. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isStale(lastPullAt: string | null, now: number = Date.now()): boolean {
  return !lastPullAt || now - Date.parse(lastPullAt) > STALE_AFTER_MS;
}

/** TZ 8.2: "Qoldiq yangilangan" / "Qarz/balans sinxronlangan" next to cached stock / customer balance. */
export function FreshnessLabel({ kind, className }: { kind: 'stock' | 'balance'; className?: string }) {
  const t = useTranslations('Common');
  const locale = useLocale();
  const { data: lastPullAt, isLoading } = useOfflineLastPullAt();
  if (isLoading) return null;
  const stale = isStale(lastPullAt ?? null);
  const text = lastPullAt
    ? t(kind === 'stock' ? 'stockUpdatedAt' : 'balanceSyncedAt', { time: formatDateTime(lastPullAt, locale) })
    : t('neverSynced');
  return (
    <p className={cn('flex items-center gap-1 text-xs', stale ? 'font-medium text-warning' : 'text-muted-foreground', className)} role={stale ? 'status' : undefined}>
      {stale && <AlertTriangle className="size-3" aria-hidden />}
      <span>{text}</span>
      {stale && lastPullAt && <span>· {t('dataStale')}</span>}
    </p>
  );
}
