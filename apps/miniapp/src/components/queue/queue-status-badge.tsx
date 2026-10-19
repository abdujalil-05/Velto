'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { PaymentStatus } from '@/lib/api/payments';
import type { QueueStatus } from '@/lib/offline/queue';
import { docStateView } from '@/lib/offline/doc-state';

/** Device-saved vs server-accepted vs failed vs conflict — never an ambiguous "saved". */
export function QueueStatusBadge({ status, paymentStatus, attemptCount }: { status: QueueStatus; paymentStatus?: PaymentStatus; attemptCount?: number }) {
  const t = useTranslations('Queue');
  const v = docStateView(status, paymentStatus, attemptCount);
  return (
    <span className="flex flex-col items-end gap-1">
      <Badge variant={v.variant}>{t(v.state)}</Badge>
      {v.detailKey && <span className="text-xs text-muted-foreground">{t(v.detailKey)}</span>}
    </span>
  );
}
