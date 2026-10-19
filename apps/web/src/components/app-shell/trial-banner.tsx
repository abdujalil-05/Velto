'use client';

import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { useSettingsQuery } from '@/lib/api/settings';
import { Alert, AlertDescription } from '@/components/ui/alert';

const WARN_DAYS = 7;

/** Non-blocking trial notice for the OWNER only: warns at <= 7 days, permanent once expired. */
export function TrialBanner() {
  const t = useTranslations('Trial');
  const { hasAnyRole } = useAuth();
  const isOwner = hasAnyRole('OWNER');
  const { data } = useSettingsQuery(isOwner);
  const sub = data?.subscription;

  if (!isOwner || !sub) return null;
  const expired = sub.status === 'TRIAL_EXPIRED';
  if (!expired && !(sub.status === 'TRIAL' && sub.daysLeft <= WARN_DAYS)) return null;

  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant={expired ? 'destructive' : 'warning'}>
        <TriangleAlert className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>{expired ? t('expired') : t('ending', { days: sub.daysLeft })}</AlertDescription>
      </Alert>
    </div>
  );
}
