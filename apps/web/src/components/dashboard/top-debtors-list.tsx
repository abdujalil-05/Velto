import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/format';
import type { DashboardData } from '@/lib/api/dashboard';

interface TopDebtorsListProps {
  debtors: DashboardData['topDebtors'];
}

export function TopDebtorsList({ debtors }: TopDebtorsListProps) {
  const t = useTranslations('Dashboard');
  const tCommon = useTranslations('Common');

  if (debtors.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t('noDebtors')}</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {debtors.map((debtor) => (
        <li key={debtor.customerId} className="flex items-center justify-between gap-3 py-2.5">
          <span className="truncate text-sm">{debtor.customerName}</span>
          <span className="shrink-0 text-sm font-medium text-destructive">
            {formatMoney(debtor.total)} {tCommon('somUnit')}
          </span>
        </li>
      ))}
    </ul>
  );
}
