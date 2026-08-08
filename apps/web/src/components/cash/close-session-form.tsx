'use client';

import { useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { CashSession } from '@/lib/api/cash-sessions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface CloseSessionFormProps {
  session: CashSession;
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (closeAmount: number) => void;
}

export function CloseSessionForm({ session, isSubmitting, submitError, onSubmit }: CloseSessionFormProps) {
  const t = useTranslations('Cash.closeForm');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const [closeAmount, setCloseAmount] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);
    const amount = Number(closeAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setValidationError(t('invalidAmount'));
      return;
    }
    onSubmit(amount);
  }

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('openedAt')}</dt>
          <dd className="font-medium">{formatDateTime(session.openedAt, locale)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('openAmount')}</dt>
          <dd className="font-medium tabular-nums">
            {formatMoney(session.openAmount)} {tCommon('somUnit')}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">{t('totalCollected')}</dt>
          <dd className="text-lg font-semibold tabular-nums text-success">
            {formatMoney(session.totalCollected)} {tCommon('somUnit')}
          </dd>
        </div>
      </dl>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="closeAmount">{t('closeAmount')}</Label>
          <Input
            id="closeAmount"
            type="number"
            min={0}
            step="0.01"
            value={closeAmount}
            onChange={(e) => setCloseAmount(e.target.value)}
          />
        </div>

        {(validationError || submitError) && (
          <Alert variant="destructive">
            <AlertDescription>{validationError ?? submitError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" variant="destructive" disabled={isSubmitting}>
          {t('submit')}
        </Button>
      </form>
    </div>
  );
}
