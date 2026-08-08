'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, WifiOff, RefreshCw } from 'lucide-react';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { cn } from '@/lib/utils';

/**
 * 9.4: "Har bir ekran offline'da to'liq ishlaydi, sinxronizatsiya holati
 * doim yuqori o'ng burchakda" — always-visible sync indicator, rendered
 * once in the (app) layout header. Tapping it forces an immediate sync
 * attempt (useful right after reconnecting, rather than waiting out the
 * 30s interval or backoff).
 */
export function SyncStatusBadge() {
  const t = useTranslations('Common');
  const { isOnline, isSyncing, pendingCount, failedCount, forceSyncNow } = useSyncEngine();

  const label = !isOnline
    ? t('offline')
    : failedCount > 0
      ? t('syncFailed', { count: failedCount })
      : pendingCount > 0
        ? t('syncPending', { count: pendingCount })
        : t('online');

  const Icon = !isOnline ? WifiOff : failedCount > 0 ? AlertTriangle : isSyncing ? Loader2 : RefreshCw;
  const colorClass = !isOnline ? 'text-muted-foreground' : failedCount > 0 ? 'text-destructive' : 'text-success';

  return (
    <button
      type="button"
      onClick={forceSyncNow}
      className={cn('inline-flex items-center gap-1 text-xs', colorClass)}
      aria-label={t('syncRetry')}
    >
      <Icon className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
      {label}
    </button>
  );
}
