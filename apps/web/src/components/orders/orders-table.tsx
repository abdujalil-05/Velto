import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { formatDate, formatMoney } from '@/lib/format';
import { OrderStatusBadge } from '@/components/shared/order-status-badge';
import { SortableHeader } from '@/components/shared/sortable-header';
import type { SortState } from '@/lib/hooks/use-sort';
import type { SalesOrder } from '@/lib/api/orders';

interface OrdersTableProps {
  orders: SalesOrder[];
  sort: SortState;
  onSort: (column: string) => void;
}

export function OrdersTable({ orders, sort, onSort }: OrdersTableProps) {
  const t = useTranslations('Orders');
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
            <th className="pb-2 pr-3 text-right font-medium">{t('total')}</th>
            <th className="pb-2 font-medium">{t('status')}</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
