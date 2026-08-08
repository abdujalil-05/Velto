'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useCustomersQuery, type Customer } from '@/lib/api/customers';
import { useInvoicesQuery } from '@/lib/api/invoices';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { formatMoney } from '@/lib/format';
import type { CreatePaymentInput, PaymentMethod } from '@/lib/api/payments';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SearchSelect } from '@/components/shared/search-select';
import { cn } from '@/lib/utils';

const METHODS: PaymentMethod[] = ['CASH', 'CARD', 'TRANSFER'];
const OPEN_STATUSES = new Set(['OPEN', 'PARTIALLY_PAID']);

interface PaymentFormProps {
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: CreatePaymentInput) => void;
}

export function PaymentForm({ isSubmitting, submitError, onSubmit }: PaymentFormProps) {
  const t = useTranslations('Payments.form');
  const tMethod = useTranslations('Payments');
  const tCommon = useTranslations('Common');

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const debouncedCustomerQuery = useDebouncedValue(customerQuery, 300);
  const { data: customerOptions, isLoading: customersLoading } = useCustomersQuery({
    page: 1,
    pageSize: 10,
    search: debouncedCustomerQuery || undefined,
  });

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [mode, setMode] = useState<'fifo' | 'manual'>('fifo');
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);

  const { data: invoicesData, isLoading: invoicesLoading } = useInvoicesQuery(
    { customerId: customer?.id, pageSize: 100 },
    mode === 'manual' && !!customer,
  );
  const openInvoices = useMemo(
    () => (invoicesData?.data ?? []).filter((inv) => OPEN_STATUSES.has(inv.status)),
    [invoicesData],
  );

  const manualTotal = useMemo(
    () => Object.values(manualAmounts).reduce((sum, v) => sum + (Number(v) || 0), 0),
    [manualAmounts],
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!customer) {
      setValidationError(t('selectCustomerFirst'));
      return;
    }
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) {
      setValidationError(t('invalidAmount'));
      return;
    }

    if (mode === 'manual') {
      const allocations = Object.entries(manualAmounts)
        .filter(([, v]) => Number(v) > 0)
        .map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) }));
      if (allocations.length === 0) {
        setValidationError(t('allocateAtLeastOne'));
        return;
      }
      if (manualTotal > amountNum) {
        setValidationError(t('allocationExceedsAmount'));
        return;
      }
      onSubmit({ customerId: customer.id, amount: amountNum, method, allocations });
    } else {
      onSubmit({ customerId: customer.id, amount: amountNum, method });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label>{t('customer')}</Label>
          <SearchSelect
            selected={customer}
            onSelect={(c) => {
              setCustomer(c);
              setManualAmounts({});
            }}
            query={customerQuery}
            onQueryChange={setCustomerQuery}
            items={customerOptions?.data ?? []}
            isLoading={customersLoading}
            getId={(c) => c.id}
            getLabel={(c) => c.name}
            getDescription={(c) => c.code}
            placeholder={t('searchCustomer')}
            emptyText={t('noCustomers')}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="amount">{t('amount')}</Label>
          <Input id="amount" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="method">{t('method')}</Label>
          <Select id="method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {tMethod(`methods.${m}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t('allocationMode')}</Label>
        <div className="flex gap-1 rounded-md border border-border p-1">
          {(['fifo', 'manual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors',
                mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t(`allocationModes.${m}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t(mode === 'fifo' ? 'fifoHint' : 'manualHint')}</p>
      </div>

      {mode === 'manual' && customer && (
        <div className="space-y-2 rounded-md border border-border p-3">
          {invoicesLoading && <p className="text-sm text-muted-foreground">{tCommon('loading')}</p>}
          {!invoicesLoading && openInvoices.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('noOpenInvoices')}</p>
          )}
          {openInvoices.map((invoice) => (
            <div key={invoice.id} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
              <div>
                <p className="text-sm font-medium">{invoice.number}</p>
                <p className="text-xs text-muted-foreground">
                  {t('outstanding')}: {formatMoney(invoice.outstanding)} {tCommon('somUnit')}
                </p>
              </div>
              <Input
                type="number"
                min={0}
                max={Number(invoice.outstanding)}
                step="0.01"
                className="w-36"
                value={manualAmounts[invoice.id] ?? ''}
                onChange={(e) => setManualAmounts((prev) => ({ ...prev, [invoice.id]: e.target.value }))}
              />
            </div>
          ))}
          {openInvoices.length > 0 && (
            <p className="pt-1 text-right text-sm font-medium">
              {t('allocatedTotal')}: {formatMoney(manualTotal)} {tCommon('somUnit')}
            </p>
          )}
        </div>
      )}

      {(validationError || submitError) && (
        <Alert variant="destructive">
          <AlertDescription>{validationError ?? submitError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {t('submit')}
      </Button>
    </form>
  );
}
