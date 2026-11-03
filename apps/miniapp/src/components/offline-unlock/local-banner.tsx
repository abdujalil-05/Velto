'use client';

import { useState } from 'react';
import { WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';

/** Persistent banner in 'offline-local' status: device-saved only, nothing server-accepted; the only exit is a verified reconnect. */
export function LocalModeBanner() {
  const t = useTranslations('OfflineUnlock');
  const { reconnect } = useAuth();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await reconnect();
      if (r.kind === 'still-offline') toast.warning(t('reconnectOffline'));
      else if (r.kind === 'mismatch') toast.warning(t('reconnectMismatch'));
      else if (r.kind === 'rejected') toast.error(t('reconnectRejected'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="flex-1">{t('localBanner')}</p>
      <Button size="sm" variant="outline" onClick={go} disabled={busy}>
        {t('reconnect')}
      </Button>
    </div>
  );
}
