'use client';

import { useTranslations } from 'next-intl';
import { ListChecks } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { attentionCount } from '@/lib/offline/queue-view';

/** Header entry to the queue screen with the needs-attention (failed + conflict) badge. */
export function QueueNavLink() {
  const t = useTranslations('Queue');
  const { failedCount, conflictCount } = useSyncEngine();
  const n = attentionCount({ failedCount, conflictCount });
  return (
    <Link href="/queue" className="relative inline-flex min-h-[44px] items-center gap-1 px-2 text-xs" aria-label={n > 0 ? `${t('navLabel')}: ${n}` : t('navLabel')}>
      <ListChecks className="h-4 w-4" aria-hidden="true" />
      {t('navLabel')}
      {n > 0 && (
        <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold text-destructive-foreground">{n}</span>
      )}
    </Link>
  );
}
