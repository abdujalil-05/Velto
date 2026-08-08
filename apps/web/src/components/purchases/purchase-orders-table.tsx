import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { formatDate, formatMoney } from '@/lib/format';
import { PurchaseOrderStatusBadge } from './purchase-order-status-badge';
import type { PurchaseOrder } from '@/lib/api/purchase-orders';

function total(po: PurchaseOrder): number {
  return po.lines.reduce((sum, l) => sum + Number(l.qty) * Number(l.unitPrice), 0);
}

interface PurchaseOrdersTableProps {
  purchaseOrders: PurchaseOrder[];
}

export function PurchaseOrdersTable({ purchaseOrders }: PurchaseOrdersTableProps) {
  const t = useTranslations('Purchases');
  const tCommon = useTranslations('Common');
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('number')}</th>
            <th className="pb-2 pr-3 font-medium">{t('supplier')}</th>
            <th className="pb-2 pr-3 font-medium">{t('date')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('total')}</th>
            <th className="pb-2 font-medium">{t('status')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {purchaseOrders.map((po) => (
            <tr key={po.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3">
                <Link href={`/purchases/${po.id}`} className="font-medium text-primary hover:underline">
                  {po.number}
                </Link>
              </td>
              <td className="py-2 pr-3">{po.supplier.name}</td>
              <td className="py-2 pr-3 text-muted-foreground">{formatDate(po.createdAt, locale)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatMoney(total(po))} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
              </td>
              <td className="py-2">
                <PurchaseOrderStatusBadge status={po.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
