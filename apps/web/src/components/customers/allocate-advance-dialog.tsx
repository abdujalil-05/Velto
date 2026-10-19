'use client';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api/client';
import { useAllocatePaymentMutation, usePaymentsQuery } from '@/lib/api/payments';
import { useInvoicesQuery } from '@/lib/api/invoices';
import { formatDate, formatMoney } from '@/lib/format';

/** Decimal string -> integer tiyin (BigInt), or null when not a valid amount with <= 2 decimals. No float math. */
function toMinor(value: string): bigint | null {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

interface Props {
  customerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AllocateAdvanceDialog({ customerId, open, onOpenChange }: Props) {
  const t = useTranslations('Customers.detail.allocate');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const key = useRef<string | null>(null);

  const payments = usePaymentsQuery({ customerId, pageSize: 100 }, );
  const openInv = useInvoicesQuery({ customerId, status: 'OPEN', pageSize: 100 });
  const partInv = useInvoicesQuery({ customerId, status: 'PARTIALLY_PAID', pageSize: 100 });
  const mutation = useAllocatePaymentMutation();

  const [paymentId, setPaymentId] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const advancePayments = useMemo(
    () => (payments.data?.data ?? []).filter((p) => p.status === 'POSTED' && (toMinor(p.advance) ?? 0n) > 0n),
    [payments.data],
  );
  const invoices = useMemo(() => [...(openInv.data?.data ?? []), ...(partInv.data?.data ?? [])], [openInv.data, partInv.data]);
  const payment = advancePayments.find((p) => p.id === (paymentId || advancePayments[0]?.id));

  const isLoading = payments.isLoading || openInv.isLoading || partInv.isLoading;
  const loadError = payments.error ?? openInv.error ?? partInv.error;

  const rows = invoices.map((inv) => {
    const raw = amounts[inv.id] ?? '';
    const minor = raw === '' ? null : toMinor(raw);
    const outstanding = toMinor(inv.outstanding) ?? 0n;
    const invalid = raw !== '' && (minor === null || minor <= 0n || minor > outstanding);
    return { inv, raw, minor, invalid };
  });
  const total = rows.reduce((s, r) => s + (r.minor && !r.invalid ? r.minor : 0n), 0n);
  const advance = payment ? (toMinor(payment.advance) ?? 0n) : 0n;
  const exceedsAdvance = total > advance;
  const anyInvalid = rows.some((r) => r.invalid);
  const filled = rows.filter((r) => r.minor !== null && r.minor > 0n);
  const canSubmit = !!payment && filled.length > 0 && !anyInvalid && !exceedsAdvance && !mutation.isPending;

  function submit() {
    if (!payment) return;
    setServerError(null);
    mutation.mutate(
      {
        id: payment.id,
        allocations: filled.map((r) => ({ invoiceId: r.inv.id, amount: r.raw.trim().replace(',', '.') })),
        idempotencyKey: (key.current ??= crypto.randomUUID()),
      },
      {
        onSuccess: () => {
          key.current = null;
          toast.success(t('success'));
          onOpenChange(false);
        },
        onError: (err) => setServerError(errorMessage(err, locale)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (mutation.isPending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {isLoading && <Skeleton className="h-32 w-full" />}

        {!isLoading && loadError && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{errorMessage(loadError, locale)}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  payments.refetch();
                  openInv.refetch();
                  partInv.refetch();
                }}
              >
                {t('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!isLoading && !loadError && advancePayments.length === 0 && <p className="text-sm text-muted-foreground">{t('noAdvance')}</p>}
        {!isLoading && !loadError && advancePayments.length > 0 && invoices.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noInvoices')}</p>
        )}

        {!isLoading && !loadError && advancePayments.length > 0 && invoices.length > 0 && payment && (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="allocPayment">{t('payment')}</Label>
              <Select id="allocPayment" value={payment.id} onChange={(e) => setPaymentId(e.target.value)} disabled={advancePayments.length === 1}>
                {advancePayments.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number}{p.source === 'OPENING' ? ` (${tCommon('openingLabel')})` : ''} · {formatDate(p.createdAt, locale)} · {t('advanceOf')} {formatMoney(p.advance)} {tCommon('somUnit')}
                  </option>
                ))}
              </Select>
            </div>

            <ul className="max-h-72 divide-y divide-border overflow-y-auto">
              {rows.map(({ inv, raw, invalid }) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">
                      {inv.number}
                      {inv.kind === 'OPENING' && <Badge variant="secondary" className="ml-2">{tCommon('openingLabel')}</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('outstanding')}: {formatMoney(inv.outstanding)} {tCommon('somUnit')}
                    </p>
                  </div>
                  <div className="w-40">
                    <Input
                      inputMode="decimal"
                      aria-label={`${t('amount')} ${inv.number}`}
                      aria-invalid={invalid}
                      value={raw}
                      onChange={(e) => {
                        key.current = null;
                        setAmounts((a) => ({ ...a, [inv.id]: e.target.value }));
                      }}
                    />
                    {invalid && <p className="mt-1 text-xs text-destructive">{t('invalidAmount')}</p>}
                  </div>
                </li>
              ))}
            </ul>

            <p className={`text-sm ${exceedsAdvance ? 'text-destructive' : 'text-muted-foreground'}`}>
              {t('total')}: {formatMoney(`${total / 100n}.${String(total % 100n).padStart(2, '0')}`)} / {formatMoney(payment.advance)} {tCommon('somUnit')}
              {exceedsAdvance && ` — ${t('exceedsAdvance')}`}
            </p>
          </div>
        )}

        {serverError && (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
