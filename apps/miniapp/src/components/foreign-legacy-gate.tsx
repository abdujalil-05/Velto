'use client';

import { ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/auth-context';
import { Button } from '@/components/ui/button';

/**
 * Blocks the whole app while legacy device-key documents of another or unknown owner are on this device.
 * Neutral message only: no count, content or ids. Rows are preserved. Recovery: ADR-068-070 "Ownerless / foreign legacy rows".
 */
export function ForeignLegacyGate() {
  const t = useTranslations('ForeignLegacyGate');
  const { logout } = useAuth();
  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <ShieldAlert className="h-8 w-8 text-destructive" aria-hidden="true" />
      <h1 className="text-base font-semibold">{t('title')}</h1>
      <p className="max-w-xs text-sm text-muted-foreground">{t('body')}</p>
      <Button variant="outline" onClick={() => void logout()}>
        {t('logout')}
      </Button>
    </div>
  );
}
