import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format';
import type { Customer } from '@/lib/api/customers';
import { SortableHeader } from '@/components/shared/sortable-header';
import type { SortState } from '@/lib/hooks/use-sort';

interface CustomersTableProps {
  customers: Customer[];
  sort: SortState;
  onSort: (column: string) => void;
  /** `customers.delete` — Owner-only on the API side. */
  canDelete?: boolean;
  onDelete?: (customer: Customer) => void;
}

export function CustomersTable({ customers, sort, onSort, canDelete = false, onDelete }: CustomersTableProps) {
  const t = useTranslations('Customers');
  const tCommon = useTranslations('Common');
  const showActions = canDelete && !!onDelete;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <SortableHeader column="code" sort={sort} onSort={onSort}>
              {t('code')}
            </SortableHeader>
            <SortableHeader column="name" sort={sort} onSort={onSort}>
              {t('name')}
            </SortableHeader>
            <th className="pb-2 pr-3 font-medium">{t('phone')}</th>
            <SortableHeader column="balance" sort={sort} onSort={onSort} align="right">
              {t('balance')}
            </SortableHeader>
            <th className="pb-2 font-medium">{t('status')}</th>
            {showActions && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {customers.map((customer) => {
            const balance = Number(customer.cachedBalance);
            return (
              <tr key={customer.id} className="hover:bg-accent/50">
                <td className="py-2 pr-3">
                  <Link href={`/customers/${customer.id}`} className="font-medium text-primary hover:underline">
                    {customer.code}
                  </Link>
                </td>
                <td className="py-2 pr-3">
                  <Link href={`/customers/${customer.id}`} className="hover:underline">
                    {customer.name}
                  </Link>
                </td>
                <td className="py-2 pr-3 text-muted-foreground">{customer.phone ?? '—'}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${balance > 0 ? 'text-destructive font-medium' : ''}`}>
                  {formatMoney(customer.cachedBalance)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
                </td>
                <td className="py-2">
                  {customer.isBlocked ? (
                    <Badge variant="destructive">{t('blocked')}</Badge>
                  ) : (
                    <Badge variant="success">{t('active')}</Badge>
                  )}
                </td>
                {showActions && (
                  <td className="py-2 text-right">
                    <Button variant="ghost" size="sm" onClick={() => onDelete?.(customer)} aria-label={t('delete')}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
