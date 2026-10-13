'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, LogIn } from 'lucide-react';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { Alert, AlertDescription } from '@/components/ui/alert';

/** TZ 8.4: early quota warning (80%), storage-full and auth-paused states — shown app-wide. */
export function SyncBanners() {
  const t = useTranslations('Queue');
  const { storage, authPaused } = useSyncEngine();
  return (
    <div className="space-y-2" aria-live="polite">
      {authPaused && (
        <Alert variant="destructive" role="alert">
          <LogIn className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            <strong className="block">{t('authPausedTitle')}</strong>
            {t('authPausedBody')}
          </AlertDescription>
        </Alert>
      )}
      {storage.level === 'full' && (
        <Alert variant="destructive" role="alert">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{t('storageFull')}</AlertDescription>
        </Alert>
      )}
      {storage.level === 'warning' && (
        <Alert>
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{t('storageWarning')}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
