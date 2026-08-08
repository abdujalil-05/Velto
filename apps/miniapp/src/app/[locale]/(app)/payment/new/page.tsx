'use client';

import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Share2 } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { useOfflineCustomers } from '@/lib/offline/use-offline-data';
import { useOpenInvoicesQuery } from '@/lib/api/invoices';
import { enqueue } from '@/lib/offline/queue';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import type { CreatePaymentInput, PaymentMethod } from '@/lib/api/payments';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { formatMoney } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const METHODS: PaymentMethod[] = ['CASH', 'CARD', 'TRANSFER'];

export default function NewPaymentPage() {
  const t = useTranslations('Payment');
  const tCommon = useTranslations('Common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const syncEngine = useSyncEngine();

  const customerId = searchParams.get('customerId');

  useTelegramBackButton(useCallback(() => router.back(), [router]));

  const customers = useOfflineCustomers();
  const customer = useMemo(() => customers.data?.find((c) => c.id === customerId), [customers.data, customerId]);

  const openInvoices = useOpenInvoicesQuery(syncEngine.isOnline ? customerId : null);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [submitting, setSubmitting] = useState(false);
  const [savedReceipt, setSavedReceipt] = useState<string | null>(null);

  const amountNum = Number(amount);
  const canSubmit = customerId && amountNum > 0 && !submitting;

  async function handleSave() {
    if (!customerId || !(amountNum > 0)) return;
    setSubmitting(true);
    try {
      const payload: CreatePaymentInput = { customerId, amount: amountNum, method, clientId: '' };
      await enqueue('payment', payload as unknown as Record<string, unknown>);
      syncEngine.notifyQueueChanged();
      toast.success(t('saved'));
      setSavedReceipt(
        [
          t('receiptTitle'),
          `${t('customer')}: ${customer?.name ?? ''}`,
          `${t('amount')}: ${formatMoney(amountNum)} ${tCommon('somUnit')}`,
          `${t('method')}: ${tCommon(`paymentMethod.${method}`)}`,
          `${new Date().toLocaleString()}`,
        ].join('\n'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function shareReceipt() {
    if (!savedReceipt) return;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ text: savedReceipt });
        return;
      } catch {
        // user cancelled the share sheet — fall through to clipboard
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(savedReceipt);
      toast.success(t('receiptCopied'));
    }
  }

  if (customers.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!customerId || !customer) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('notFound')}</AlertDescription>
      </Alert>
    );
  }

  if (savedReceipt) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Check className="h-10 w-10 text-success" />
            <p className="font-medium">{t('saved')}</p>
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-left text-xs">{savedReceipt}</pre>
          </CardContent>
        </Card>
        <Button size="lg" variant="secondary" className="w-full gap-2" onClick={shareReceipt}>
          <Share2 className="h-4 w-4" />
          {t('shareReceipt')}
        </Button>
        <Button size="lg" className="w-full" onClick={() => router.push('/route')}>
          {tCommon('done')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('customer')}</p>
        <h1 className="text-lg font-semibold">{customer.name}</h1>
      </div>

      <Card>
        <CardContent className="space-y-1 py-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('currentDebt')}</p>
          <p className={cn('text-2xl font-bold tabular-nums', Number(customer.cachedBalance) > 0 && 'text-destructive')}>
            {formatMoney(customer.cachedBalance)} {tCommon('somUnit')}
          </p>
        </CardContent>
      </Card>

      {syncEngine.isOnline ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('openInvoices')}</p>
          {openInvoices.isLoading && <Skeleton className="h-16 w-full" />}
          {openInvoices.data && openInvoices.data.length === 0 && <p className="text-sm text-muted-foreground">{t('noOpenInvoices')}</p>}
          {openInvoices.data && openInvoices.data.length > 0 && (
            <div className="divide-y divide-border rounded-md border border-border">
              {openInvoices.data.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{inv.number}</span>
                  <span className="tabular-nums text-destructive">
                    {formatMoney(inv.outstanding)} {tCommon('somUnit')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <Alert>
          <AlertDescription>{t('invoicesNeedConnection')}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="amount">{t('amount')}</Label>
        <Input id="amount" type="number" inputMode="decimal" min={0} step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className="h-12 text-lg" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="method">{t('method')}</Label>
        <Select id="method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className="h-12">
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {tCommon(`paymentMethod.${m}`)}
            </option>
          ))}
        </Select>
      </div>

      <Button size="lg" className="w-full" disabled={!canSubmit} onClick={handleSave}>
        {t('save')}
      </Button>
    </div>
  );
}
