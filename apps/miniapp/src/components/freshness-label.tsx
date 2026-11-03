'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { useOfflineDatasetSyncTimes } from '@/lib/offline/use-offline-data';
import { DATASET_KEYS, isDatasetStale, type DatasetKey } from '@/lib/offline/staleness';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Common message key per dataset ("<Dataset> synced: {time}"). */
const MESSAGE_KEY: Record<DatasetKey, string> = {
  products: 'productsSyncedAt',
  prices: 'pricesSyncedAt',
  customers: 'customersSyncedAt',
  stock: 'stockUpdatedAt',
  balances: 'balanceSyncedAt',
  route: 'routeSyncedAt',
};

/** TZ 8.2/8.6: last successful sync of one dataset, with a stale warning (never a silent change). */
export function FreshnessLabel({ dataset, className }: { dataset: DatasetKey; className?: string }) {
  const t = useTranslations('Common');
  const locale = useLocale();
  const { data, isLoading } = useOfflineDatasetSyncTimes();
  if (isLoading) return null;
  const last = data?.[dataset] ?? null;
  const stale = isDatasetStale(last, dataset);
  const text = last ? t(MESSAGE_KEY[dataset], { time: formatDateTime(last, locale) }) : t('neverSynced');
  return (
    <p className={cn('flex items-center gap-1 text-xs', stale ? 'font-medium text-warning' : 'text-muted-foreground', className)} role={stale ? 'status' : undefined}>
      {stale && <AlertTriangle className="size-3" aria-hidden />}
      <span>{text}</span>
      {stale && last && <span>· {t('dataStale')}</span>}
    </p>
  );
}

/** All datasets at once (queue/status screen). */
export function DatasetFreshnessList() {
  return (
    <div className="space-y-1">
      {DATASET_KEYS.map((k) => (
        <FreshnessLabel key={k} dataset={k} />
      ))}
    </div>
  );
}
