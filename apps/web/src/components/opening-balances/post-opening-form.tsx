'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, Loader2, TriangleAlert } from 'lucide-react';
import { ApiError, errorMessage } from '@/lib/api/client';
import { usePostOpeningMutation, type OpeningBatch } from '@/lib/api/opening-balances';
import { formatMoney, formatQty } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MONEY_PATTERN, QTY_PATTERN, canonicalDecimal, sameDecimal } from './decimal';

const todayLocal = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD

export function PostOpeningForm({ batch, onPosted }: { batch: OpeningBatch; onPosted: (posted: OpeningBatch) => void }) {
  const t = useTranslations('OpeningBalances.post');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const mutation = usePostOpeningMutation();
  const isStock = batch.kind === 'STOCK';
  const key = useRef<string | null>(null);

  const [asOfDate, setAsOfDate] = useState('');
  const [source, setSource] = useState('');
  const [controlDebt, setControlDebt] = useState('');
  const [controlCredit, setControlCredit] = useState('');
  const [controlQty, setControlQty] = useState('');
  const [signOff, setSignOff] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const today = todayLocal();
  const debtValue = isStock ? '0' : controlDebt;
  const creditValue = isStock ? '0' : controlCredit;
  const qtyValue = isStock ? controlQty : '0';

  const errors = {
    asOfDate: !asOfDate ? t('dateRequired') : asOfDate > today ? t('dateFuture') : null,
    source: source.trim().length < 1 || source.trim().length > 200 ? t('sourceInvalid') : null,
    debt: !MONEY_PATTERN.test(debtValue) ? t('amountInvalid') : null,
    credit: !MONEY_PATTERN.test(creditValue) ? t('amountInvalid') : null,
    qty: !QTY_PATTERN.test(qtyValue) ? t('qtyInvalid') : null,
    signOff: !signOff ? t('signOffRequired') : null,
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const mismatch =
    !errors.debt && !errors.credit && !errors.qty &&
    (isStock
      ? !sameDecimal(qtyValue, batch.qtyTotal)
      : !sameDecimal(debtValue, batch.debtTotal) || !sameDecimal(creditValue, batch.creditTotal));

  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      key.current = null;
      setServerError(null);
      setter(v);
    };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (hasErrors) return;
    if (!key.current) key.current = crypto.randomUUID();
    setServerError(null);
    mutation.mutate(
      {
        id: batch.id,
        idempotencyKey: key.current,
        input: {
          asOfDate,
          source: source.trim(),
          controlDebt: canonicalDecimal(debtValue),
          controlCredit: canonicalDecimal(creditValue),
          controlQty: canonicalDecimal(qtyValue),
          signOff,
        },
      },
      {
        onSuccess: onPosted,
        onError: (err) => {
          // Business refusals are final for this input; the next attempt after an edit gets a new key.
          if (err instanceof ApiError && err.status < 500) key.current = null;
          let msg = errorMessage(err, locale);
          if (err instanceof ApiError && err.code === 'OPENING_TOTALS_MISMATCH') {
            const exp = (err.details as { expected?: Record<string, string> } | undefined)?.expected;
            if (exp) msg += ` ${t('mismatchExpected', { debt: exp.debtTotal ?? '-', credit: exp.creditTotal ?? '-', qty: exp.qtyTotal ?? '-' })}`;
          }
          setServerError(msg);
        },
      },
    );
  }

  const show = (msg: string | null) =>
    touched && msg ? (
      <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
        {msg}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h3 className="text-sm font-semibold">{t('title')}</h3>

      <Alert variant="warning">
        <TriangleAlert className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>{t('cutover')}</AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="obAsOf">{t('asOfDate')}</Label>
          <Input id="obAsOf" type="date" max={today} value={asOfDate} onChange={(e) => edit(setAsOfDate)(e.target.value)} aria-invalid={touched && !!errors.asOfDate} />
          {show(errors.asOfDate)}
        </div>
        <div>
          <Label htmlFor="obSource">{t('source')}</Label>
          <Input id="obSource" maxLength={200} placeholder={t('sourcePlaceholder')} value={source} onChange={(e) => edit(setSource)(e.target.value)} aria-invalid={touched && !!errors.source} />
          {show(errors.source)}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t('controlTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('controlHint')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {isStock ? (
            <div>
              <Label htmlFor="obCtrlQty">{t('controlQty')}</Label>
              <Input id="obCtrlQty" inputMode="decimal" value={controlQty} onChange={(e) => edit(setControlQty)(e.target.value)} aria-invalid={touched && !!errors.qty} />
              {show(errors.qty)}
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="obCtrlDebt">{t('controlDebt')}</Label>
                <Input id="obCtrlDebt" inputMode="decimal" value={controlDebt} onChange={(e) => edit(setControlDebt)(e.target.value)} aria-invalid={touched && !!errors.debt} />
                {show(errors.debt)}
              </div>
              <div>
                <Label htmlFor="obCtrlCredit">{t('controlCredit')}</Label>
                <Input id="obCtrlCredit" inputMode="decimal" value={controlCredit} onChange={(e) => edit(setControlCredit)(e.target.value)} aria-invalid={touched && !!errors.credit} />
                {show(errors.credit)}
              </div>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('previewTotals')}:{' '}
          {isStock
            ? formatQty(batch.qtyTotal)
            : `${formatMoney(batch.debtTotal)} / ${formatMoney(batch.creditTotal)} ${tCommon('somUnit')}`}
        </p>
      </div>

      {mismatch && (
        <Alert variant="warning">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{t('mismatch')}</AlertDescription>
        </Alert>
      )}

      <div>
        <label className="flex min-h-12 cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 h-5 w-5" checked={signOff} onChange={(e) => edit(setSignOff)(e.target.checked)} aria-invalid={touched && !!errors.signOff} />
          <span>{t('signOff')}</span>
        </label>
        {show(errors.signOff)}
      </div>

      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={mutation.isPending} variant={mismatch ? 'destructive' : 'default'}>
          {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {mismatch ? t('submitAnyway') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
