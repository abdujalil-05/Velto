'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { queueRepository } from '@/lib/offline/queue';
import { emergencyWipe } from '@/lib/offline/held-seal';
import { stopSyncAndWait } from '@/lib/offline/sync-engine-core';
import { downloadJson, exportFileName } from '@/lib/offline/queue-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';

/**
 * Logout guard (TZ 8.1): unsynced documents exist only on this device, so a
 * plain logout is blocked behind Export / Discard (explicit confirm) / Cancel.
 * `logout({force:true})` runs only after a finished export or a confirmed discard.
 */
export function LogoutButton() {
  const t = useTranslations('Queue');
  const { logout } = useAuth();
  const [count, setCount] = useState(0);
  const [guardOpen, setGuardOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);

  async function onLogoutClick() {
    const unsynced = await queueRepository.unsyncedCountForLogout();
    if (unsynced === 0) {
      await logout();
      return;
    }
    setCount(unsynced);
    setGuardOpen(true);
  }

  async function exportThenLogout() {
    try {
      downloadJson(await queueRepository.exportPendingToJson(), exportFileName());
    } catch {
      toast.error(t('actionError'));
      return; // export failed: never wipe
    }
    setGuardOpen(false);
    await logout({ force: true });
  }

  return (
    <>
      <Button type="button" variant="outline" size="lg" className="w-full gap-2" onClick={() => void onLogoutClick()}>
        <LogOut className="h-4 w-4" aria-hidden="true" />
        {t('logout')}
      </Button>
      {/* Distinct from sign-out: destroys ALL local data incl. held payments, behind an explicit confirm. */}
      <Button type="button" variant="ghost" size="sm" className="w-full text-destructive" onClick={() => setWipeOpen(true)}>
        {t('wipeButton')}
      </Button>

      <Dialog open={guardOpen && !discardOpen} placement="bottom" onOpenChange={setGuardOpen}>
        <DialogContent className="rounded-b-none rounded-t-2xl border-b-0 p-5" role="alertdialog" aria-label={t('logoutBlockedTitle')}>
          <h2 className="text-base font-semibold">{t('logoutBlockedTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('logoutBlockedDescription', { count })}</p>
          <div className="mt-5 flex flex-col gap-2">
            <Button type="button" size="lg" onClick={() => void exportThenLogout()}>
              {t('logoutExport')}
            </Button>
            <Button type="button" variant="destructive" size="lg" onClick={() => setDiscardOpen(true)}>
              {t('logoutDiscard')}
            </Button>
            <Button type="button" variant="outline" size="lg" onClick={() => setGuardOpen(false)}>
              {t('logoutCancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmSheet
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('logoutDiscardConfirmTitle')}
        description={t('logoutDiscardConfirmDescription', { count })}
        confirmLabel={t('logoutDiscardConfirm')}
        onConfirm={async () => {
          setDiscardOpen(false);
          setGuardOpen(false);
          await logout({ force: true });
        }}
      />
    
      <ConfirmSheet
        open={wipeOpen}
        onOpenChange={setWipeOpen}
        title={t('wipeTitle')}
        description={t('wipeWarning')}
        confirmLabel={t('wipeConfirm')}
        onConfirm={async () => {
          setWipeOpen(false);
          try {
            await stopSyncAndWait();
            await emergencyWipe();
          } catch {
            toast.error(t('actionError'));
            return;
          }
          await logout({ force: true });
        }}
      />
    </>
  );
}
