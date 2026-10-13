import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SortableHeader } from '@/components/shared/sortable-header';
import type { SortState } from '@/lib/hooks/use-sort';
import type { Payment } from '@/lib/api/payments';

const METHOD_VARIANT = { CASH: 'success', CARD: 'secondary', TRANSFER: 'outline' } as const;

interface PaymentsTableProps {
  payments: Payment[];
  sort: SortState;
  onSort: (column: string) => void;
  /** Shows the per-row reverse button (`payments.reverse`). */
  canReverse?: boolean;
  onReverse?: (payment: Payment) => void;
}

export function PaymentsTable({ payments, sort, onSort, canReverse = false, onReverse }: PaymentsTableProps) {
  const t = useTranslations('Payments');
  const tCommon = useTranslations('Common');
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <SortableHeader column="number" sort={sort} onSort={onSort}>
              {t('number')}
            </SortableHeader>
            <th className="pb-2 pr-3 font-medium">{t('customer')}</th>
            <SortableHeader column="createdAt" sort={sort} onSort={onSort}>
              {t('date')}
            </SortableHeader>
            <th className="pb-2 pr-3 font-medium">{t('method')}</th>
            <SortableHeader column="amount" sort={sort} onSort={onSort} align="right">
              {t('amount')}
            </SortableHeader>
            <th className="pb-2 pl-3 font-medium">{t('status')}</th>
            {canReverse && <th className="pb-2 pl-3 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {payments.map((payment) => (
            <tr key={payment.id}>
              <td className="py-2 pr-3 font-medium">{payment.number}</td>
              <td className="py-2 pr-3">
                <Link href={`/customers/${payment.customerId}`} className="text-primary hover:underline">
                  {payment.customer.name}
                </Link>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{formatDateTime(payment.createdAt, locale)}</td>
              <td className="py-2 pr-3">
                <Badge variant={METHOD_VARIANT[payment.method]}>{t(`methods.${payment.method}`)}</Badge>
              </td>
              <td className="py-2 text-right font-semibold tabular-nums">
                {formatMoney(payment.amount)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
              </td>
              <td className="py-2 pl-3">
                {payment.status === 'REVERSED' ? (
                  <Badge variant="destructive">{t('statuses.REVERSED')}</Badge>
                ) : (
                  <Badge variant="success">{t('statuses.POSTED')}</Badge>
                )}
              </td>
              {canReverse && (
                <td className="py-2 pl-3 text-right">
                  {payment.status === 'POSTED' && (
                    <Button variant="ghost" size="sm" onClick={() => onReverse?.(payment)}>
                      <Undo2 className="mr-1 h-4 w-4" />
                      {t('reverse.action')}
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
