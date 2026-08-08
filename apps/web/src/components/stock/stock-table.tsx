import { useTranslations } from 'next-intl';
import { formatQty } from '@/lib/format';
import { SortableHeader } from '@/components/shared/sortable-header';
import type { SortState } from '@/lib/hooks/use-sort';
import type { StockLevelRow } from '@/lib/api/stock';

interface StockTableProps {
  rows: StockLevelRow[];
  sort: SortState;
  onSort: (column: string) => void;
}

export function StockTable({ rows, sort, onSort }: StockTableProps) {
  const t = useTranslations('Stock');

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <SortableHeader column="product" sort={sort} onSort={onSort}>
              {t('product')}
            </SortableHeader>
            <SortableHeader column="warehouse" sort={sort} onSort={onSort}>
              {t('warehouse')}
            </SortableHeader>
            <SortableHeader column="onHand" sort={sort} onSort={onSort} align="right">
              {t('onHand')}
            </SortableHeader>
            <SortableHeader column="reserved" sort={sort} onSort={onSort} align="right">
              {t('reserved')}
            </SortableHeader>
            <th className="pb-2 text-right font-medium">{t('available')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={`${row.productId}-${row.warehouseId}`}>
              <td className="py-2 pr-3">
                <p className="font-medium">{row.product.name}</p>
                <p className="text-xs text-muted-foreground">{row.product.sku}</p>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.warehouse.name}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatQty(row.onHand)} <span className="text-xs text-muted-foreground">{row.product.baseUnit}</span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{formatQty(row.reserved)}</td>
              <td className="py-2 text-right font-semibold tabular-nums">{formatQty(row.available)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
