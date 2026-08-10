import { useLocale, useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney } from '@/lib/format';
import { OrderStatusBadge } from '@/components/shared/order-status-badge';
import { SortableHeader } from '@/components/shared/sortable-header';
import type { SortState } from '@/lib/hooks/use-sort';
import type { SalesOrder } from '@/lib/api/orders';

interface OrdersTableProps {
  orders: SalesOrder[];
  sort: SortState;
  onSort: (column: string) => void;
  /** `orders.update` — API only allows deleting SUBMITTED orders. */
  canDelete?: boolean;
  onDelete?: (order: SalesOrder) => void;
}

export function OrdersTable({ orders, sort, onSort, canDelete = false, onDelete }: OrdersTableProps) {
  const t = useTranslations('Orders');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const showActions = canDelete && !!onDelete;

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
            <th className="pb-2 pr-3 text-right font-medium">{t('total')}</th>
            <th className="pb-2 font-medium">{t('status')}</th>
            {showActions && <th className="pb-2 text-right font-medium">{t('actions')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3">
                <Link href={`/orders/${order.id}`} className="font-medium text-primary hover:underline">
                  {order.number}
                </Link>
              </td>
              <td className="py-2 pr-3">
                <Link href={`/orders/${order.id}`} className="hover:underline">
                  {order.customer.name}
                </Link>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{formatDate(order.createdAt, locale)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatMoney(order.total)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
              </td>
              <td className="py-2">
                <OrderStatusBadge status={order.status} />
              </td>
              {showActions && (
                <td className="py-2 text-right">
                  {order.status === 'SUBMITTED' && (
                    <Button variant="ghost" size="sm" onClick={() => onDelete?.(order)} aria-label={t('delete')}>
                      <Trash2 className="h-4 w-4 text-destructive" />
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
