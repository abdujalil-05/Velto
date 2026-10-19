'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { queueRepository } from '@/lib/offline/queue';
import { downloadJson, exportFileName } from '@/lib/offline/queue-view';
import { Button } from '@/components/ui/button';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';

/** Shown after the server revoked/blocked the session: cache is wiped, unsynced documents are quarantined (kept, never sent) until exported or explicitly discarded. */
export function RevokedNotice() {
  const t = useTranslations('Revoked');
  const tq = useTranslations('Queue');
  const { revoked, resolveRevoked } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  useEffect(() => {
    if (!revoked) return;
    void queueRepository.listRevokedFor(revoked).then((rows) => setCount(rows.length));
  }, [revoked]);

  if (!revoked) return null;

  async function onExport() {
    if (!revoked) return;
    try {
      downloadJson(await queueRepository.exportRevokedToJson(revoked), exportFileName());
    } catch {
      toast.error(tq('actionError'));
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <ShieldAlert className="h-7 w-7" aria-hidden />
      </div>
      <div className="space-y-2">
        <h1 className="text-base font-semibold">{t('title')}</h1>
        <p className="max-w-xs text-sm text-muted-foreground">{t('body')}</p>
        <p className="max-w-xs text-sm font-medium">{t('quarantined', { count: count ?? 0 })}</p>
        <p className="max-w-xs text-xs text-muted-foreground">{t('notSent')}</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button size="lg" onClick={() => void onExport()} disabled={!count}>
          {t('export')}
        </Button>
        <Button variant="destructive" size="lg" onClick={() => setDiscardOpen(true)} disabled={!count}>
          {t('discard')}
        </Button>
        <Button variant="outline" size="lg" onClick={() => void resolveRevoked({ hide: true })}>
          {t('continue')}
        </Button>
      </div>
      <ConfirmSheet
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('discardConfirmTitle')}
        description={t('discardConfirmDescription', { count: count ?? 0 })}
        confirmLabel={t('discardConfirm')}
        onConfirm={async () => {
          setDiscardOpen(false);
          await queueRepository.discardRevokedFor(revoked);
          setCount(0);
          await resolveRevoked();
        }}
      />
    </div>
  );
}
