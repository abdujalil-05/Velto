'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { QueueStatus } from '@/lib/offline/queue';
import { statusView } from '@/lib/offline/queue-view';

/** Device-saved vs server-accepted vs failed vs conflict — never an ambiguous "saved". */
export function QueueStatusBadge({ status }: { status: QueueStatus }) {
  const t = useTranslations('Queue');
  const v = statusView(status);
  return <Badge variant={v.variant}>{t(v.labelKey)}</Badge>;
}
