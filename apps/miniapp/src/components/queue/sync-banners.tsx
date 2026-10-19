'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, LogIn } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { queueRepository } from '@/lib/offline/queue';
import { downloadJson, exportFileName } from '@/lib/offline/queue-view';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';

/** TZ 8.4: early quota warning (80%), storage-full and auth-paused states — shown app-wide. */
export function SyncBanners() {
  const t = useTranslations('Queue');
  const { storage, authPaused } = useSyncEngine();
  const { resolveRevoked } = useAuth();
  const [quarantined, setQuarantined] = useState(0);
  const [releaseOpen, setReleaseOpen] = useState(false);
  useEffect(() => {
    void queueRepository.listOwnQuarantined().then((r) => setQuarantined(r.length)).catch(() => {});
  }, []);
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
      {quarantined > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            <strong className="block">{t('quarantineTitle')}</strong>
            {t('quarantineBody', { count: quarantined })}
            <span className="mt-2 flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={async () => downloadJson(JSON.stringify({ exportedAt: new Date().toISOString(), items: (await queueRepository.listOwnQuarantined()).map((e) => ({ clientId: e.clientId, type: e.type, status: e.status, createdAt: e.createdAt, payload: e.payload })) }, null, 2), exportFileName())}>
                {t('quarantineExport')}
              </Button>
              <Button type="button" size="sm" onClick={() => setReleaseOpen(true)}>
                {t('quarantineRelease')}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}
      <ConfirmSheet
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title={t('quarantineReleaseTitle')}
        description={t('quarantineReleaseDescription', { count: quarantined })}
        confirmLabel={t('quarantineReleaseConfirm')}
        tone="default"
        onConfirm={async () => {
          setReleaseOpen(false);
          await queueRepository.releaseOwnQuarantine();
          await resolveRevoked();
          setQuarantined(0);
        }}
      />
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
