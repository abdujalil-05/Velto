'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import {
  useConfirmPaymentReconciliationMutation,
  usePaymentReconciliationsQuery,
  type ConfirmPaymentReconciliationResult,
  type PaymentReconciliationItem,
  type PaymentReconciliationOutcome,
} from '@/lib/api/payment-reconciliations';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/shared/pagination-bar';

const REASON_MIN = 10;

export function PaymentConflictsSection() {
  const t = useTranslations('Reconciliation.paymentConflicts');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('payments.read');
  const canConfirm = hasPermission('payments.handover');

  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<PaymentReconciliationItem | null>(null);
  const [outcome, setOutcome] = useState<PaymentReconciliationOutcome>('EXISTING_PAYMENT_CONFIRMED');
  const [reason, setReason] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmPaymentReconciliationResult | null>(null);

  const list = usePaymentReconciliationsQuery({ page, pageSize: 10 }, canRead);
  const confirm = useConfirmPaymentReconciliationMutation();

  if (!canRead) return null;

  function open(item: PaymentReconciliationItem) {
    setTarget(item);
    setOutcome('EXISTING_PAYMENT_CONFIRMED');
    setReason('');
    setEvidenceRef('');
    setValidation(null);
    setResult(null);
    confirm.reset();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    if (reason.trim().length < REASON_MIN) return setValidation(t('form.reasonShort', { min: REASON_MIN }));
    if (outcome === 'NOT_POSTED_CONFIRMED' && !evidenceRef.trim()) return setValidation(t('form.evidenceRequired'));
    setValidation(null);
    confirm.mutate(
      {
        clientId: target.clientId,
        outcome,
        reason: reason.trim(),
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
      },
      {
        onSuccess: (r) => {
          setResult(r);
          setTarget(null);
        },
      },
    );
  }

  return (
    <section className="space-y-3 pt-2" aria-labelledby="payment-conflicts-title">
      <div>
        <h2 id="payment-conflicts-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Alert>
        <AlertDescription className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('warning')}</span>
        </AlertDescription>
      </Alert>

      {result && (
        <Alert variant="success" role="status">
          <AlertDescription className="space-y-1">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {result.replayed ? t('result.replayed') : t('result.done')}
            </p>
            <p className="text-xs">
              {t(`outcome.${result.resolution.outcome}`)} · {t('result.payment')} {result.snapshot.number} ·{' '}
              {formatMoney(result.snapshot.amount)} · {result.snapshot.status}
            </p>
          </AlertDescription>
        </Alert>
      )}

      {list.isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      )}

      {list.isError && !list.isLoading && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(list.error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => list.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {list.data && list.data.data.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <ShieldCheck className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      )}

      {list.data && list.data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('col.number')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.amount')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.status')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.rejections')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.last')}</th>
                    {canConfirm && <th className="pb-2 font-medium" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.data.data.map((p) => (
                    <tr key={p.clientId}>
                      <td className="py-2 pr-3 font-mono text-xs">{p.number}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatMoney(p.amount)}</td>
                      <td className="py-2 pr-3">{p.status}</td>
                      <td className="py-2 pr-3">{p.rejectionCount}</td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{formatDateTime(p.lastRejectedAt, locale)}</td>
                      {canConfirm && (
                        <td className="py-2 text-right">
                          <Button variant="outline" size="sm" onClick={() => open(p)}>
                            {t('confirmAction')}
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar meta={list.data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      {canConfirm && target && (
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={submit} className="space-y-4" aria-labelledby="payment-conflict-form-title" noValidate>
              <h3 id="payment-conflict-form-title" className="font-medium">
                {t('form.title', { number: target.number })}
              </h3>
              <div className="space-y-1">
                <label htmlFor="pc-outcome" className="text-sm font-medium">
                  {t('form.outcome')}
                </label>
                <Select id="pc-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as PaymentReconciliationOutcome)}>
                  <option value="EXISTING_PAYMENT_CONFIRMED">{t('outcome.EXISTING_PAYMENT_CONFIRMED')}</option>
                  <option value="NOT_POSTED_CONFIRMED">{t('outcome.NOT_POSTED_CONFIRMED')}</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor="pc-reason" className="text-sm font-medium">
                  {t('form.reason')}
                </label>
                <Textarea
                  id="pc-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={1000}
                  required
                  aria-required="true"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="pc-evidence" className="text-sm font-medium">
                  {t('form.evidence')}
                  {outcome === 'NOT_POSTED_CONFIRMED' ? ' *' : ''}
                </label>
                <Input
                  id="pc-evidence"
                  value={evidenceRef}
                  onChange={(e) => setEvidenceRef(e.target.value)}
                  maxLength={500}
                  required={outcome === 'NOT_POSTED_CONFIRMED'}
                  aria-required={outcome === 'NOT_POSTED_CONFIRMED'}
                  aria-describedby="pc-evidence-hint"
                />
                <p id="pc-evidence-hint" className="text-xs text-muted-foreground">
                  {t('form.evidenceHint')}
                </p>
              </div>
              {(validation || confirm.isError) && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{validation ?? errorMessage(confirm.error, locale)}</span>
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={confirm.isPending}>
                  {t('form.submit')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setTarget(null)} disabled={confirm.isPending}>
                  {t('form.cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
