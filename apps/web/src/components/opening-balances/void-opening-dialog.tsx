'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useVoidOpeningMutation, type OpeningBatch } from '@/lib/api/opening-balances';
import { ReverseDialog } from '@/components/shared/reverse-dialog';

export function VoidOpeningDialog({ batch, onClose }: { batch: OpeningBatch | null; onClose: () => void }) {
  const t = useTranslations('OpeningBalances.void');
  const locale = useLocale();
  const mutation = useVoidOpeningMutation();
  const [error, setError] = useState<string | null>(null);
  // One key per batch+reason attempt; reused on retry until the server accepts it.
  const keys = useRef<Map<string, string>>(new Map());

  function close() {
    setError(null);
    onClose();
  }

  function submit(reason: string) {
    if (!batch) return;
    const k = `${batch.id}:${reason}`;
    if (!keys.current.has(k)) keys.current.set(k, crypto.randomUUID());
    setError(null);
    mutation.mutate(
      { id: batch.id, reason, idempotencyKey: keys.current.get(k)! },
      {
        onSuccess: () => {
          keys.current.delete(k);
          toast.success(t('success'));
          close();
        },
        onError: (err) => {
          // A new attempt with the same reason after a business refusal must not replay a cached failure.
          keys.current.delete(k);
          const touched = err instanceof ApiError && err.code === 'OPENING_BATCH_TOUCHED';
          setError(touched ? `${errorMessage(err, locale)} ${t('touchedHint')}` : errorMessage(err, locale));
        },
      },
    );
  }

  return (
    <ReverseDialog
      key={batch?.id ?? 'none'}
      open={batch !== null}
      onOpenChange={(open) => !open && close()}
      title={t('title')}
      description={t('description')}
      error={error}
      isPending={mutation.isPending}
      onConfirm={submit}
      confirmLabel={t('confirm')}
    />
  );
}
