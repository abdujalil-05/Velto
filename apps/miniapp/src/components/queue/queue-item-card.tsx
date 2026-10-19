'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { QueueEntry } from '@/lib/offline/queue';
import { queueRepository } from '@/lib/offline/queue';
import { isRejectedHandover, localizedError, parsePriceChanged } from '@/lib/offline/queue-view';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';
import { QueueStatusBadge } from './queue-status-badge';

interface Props {
  entry: QueueEntry;
  name: string | null;
  productName: (productId: string) => string;
  /** Called after any queue mutation so counts/lists refresh. */
  onChanged: () => void;
}

type Pending = 'resubmit' | 'discard' | null;

/** One queue row. Actions are explicit and always behind a confirm sheet — nothing is auto-applied. */
export function QueueItemCard({ entry, name, productName, onChanged }: Props) {
  const t = useTranslations('Queue');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const [confirm, setConfirm] = useState<Pending>(null);

  const price = parsePriceChanged(entry);
  const errorText = localizedError(entry.lastError, locale);
  const unaccepted = (entry.status === 'FAILED' || entry.status === 'CONFLICT') && !entry.serverId;
  const unsent = entry.status !== 'SYNCED';

  async function run(action: () => Promise<unknown>, okMsg: string) {
    try {
      await action();
      toast.success(okMsg);
      onChanged();
    } catch {
      toast.error(t('actionError'));
    } finally {
      setConfirm(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t(`type.${entry.type}`)}</p>
            <p className="truncate text-sm">{name ?? t('unknownName')}</p>
            <p className="text-xs text-muted-foreground">
              {t('createdAt')}: {formatDateTime(entry.createdAt, locale)}
            </p>
          </div>
          <QueueStatusBadge status={entry.status} paymentStatus={entry.paymentStatus} />
        </div>

        {unsent && <p className="text-xs text-muted-foreground">{t('deviceOnlyNote')}</p>}

        {entry.status === 'SYNCED' && entry.paymentStatus === 'PENDING_HANDOVER' && (
          <p className="rounded-md bg-warning/20 p-2 text-sm">{t('handoverPendingNote')}</p>
        )}

        {isRejectedHandover(entry) && (
          <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            <span className="font-medium">{t('handoverRejectedNote')}</span>
            {entry.handoverRejectReason ? ` ${t('reason')}: ${entry.handoverRejectReason}` : ''}
          </p>
        )}

        {entry.status === 'FAILED' && errorText && (
          <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            <span className="font-medium">{t('reason')}:</span> {errorText}
          </p>
        )}

        {entry.status === 'CONFLICT' && !price && (
          <p className="rounded-md bg-warning/20 p-2 text-sm">
            <span className="font-medium">{t('otherConflict')}</span>
            {errorText ? `: ${errorText}` : ''}
          </p>
        )}

        {price && (
          <div className="space-y-2 rounded-md bg-warning/20 p-3 text-sm">
            <p className="font-medium">{t('priceChangedTitle')}</p>
            <ul className="space-y-1">
              {price.lines.map((l) => (
                <li key={l.lineIndex} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{productName(l.productId)}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="text-muted-foreground line-through">{formatMoney(l.expectedUnitPrice)}</span> → <span className="font-semibold">{formatMoney(l.serverUnitPrice)}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="flex justify-between tabular-nums">
              <span>{t('oldTotal')}</span>
              <span>
                {formatMoney(price.expectedTotal)} {tCommon('somUnit')}
              </span>
            </p>
            <p className="flex justify-between font-semibold tabular-nums">
              <span>{t('newTotal')}</span>
              <span>
                {formatMoney(price.serverTotal)} {tCommon('somUnit')}
              </span>
            </p>
          </div>
        )}

        {price && (
          <div className="flex flex-col gap-2">
            <Button type="button" size="lg" onClick={() => setConfirm('resubmit')}>
              {t('resubmit')}
            </Button>
            <Button type="button" size="lg" variant="outline" onClick={() => setConfirm('discard')}>
              {t('cancelDoc')}
            </Button>
          </div>
        )}

        {!price && unaccepted && (
          <Button type="button" size="lg" variant="outline" className="w-full" onClick={() => setConfirm('discard')}>
            {entry.status === 'CONFLICT' ? t('cancelDoc') : t('discard')}
          </Button>
        )}
      </CardContent>

      <ConfirmSheet
        open={confirm === 'resubmit'}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="default"
        queued
        title={t('resubmitConfirmTitle')}
        description={t('resubmitConfirmDescription', { total: price ? formatMoney(price.serverTotal) : '' })}
        itemName={name ?? undefined}
        confirmLabel={t('resubmitConfirm')}
        onConfirm={() => run(() => queueRepository.resolveConflictResubmit(entry.clientId), t('resubmitDone'))}
      />
      <ConfirmSheet
        open={confirm === 'discard'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={entry.status === 'CONFLICT' ? t('cancelConfirmTitle') : t('discardConfirmTitle')}
        description={entry.status === 'CONFLICT' ? t('cancelConfirmDescription') : t('discardConfirmDescription')}
        itemName={name ?? undefined}
        confirmLabel={entry.status === 'CONFLICT' ? t('cancelConfirm') : t('discard')}
        onConfirm={() => run(() => queueRepository.discardFailedItem(entry.clientId), t('discardDone'))}
      />
    </Card>
  );
}
