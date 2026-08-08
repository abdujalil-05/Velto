import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { SortableHeader } from '@/components/shared/sortable-header';
import type { SortState } from '@/lib/hooks/use-sort';
import type { Payment } from '@/lib/api/payments';

const METHOD_VARIANT = { CASH: 'success', CARD: 'secondary', TRANSFER: 'outline' } as const;

interface PaymentsTableProps {
  payments: Payment[];
  sort: SortState;
  onSort: (column: string) => void;
}

export function PaymentsTable({ payments, sort, onSort }: PaymentsTableProps) {
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
