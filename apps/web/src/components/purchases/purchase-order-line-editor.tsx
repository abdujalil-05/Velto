'use client';

import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SearchSelect } from '@/components/shared/search-select';
import { Button } from '@/components/ui/button';
import { useProductsQuery, type Product } from '@/lib/api/products';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { formatMoney } from '@/lib/format';
import type { PurchaseOrderLineDraft } from './purchase-order-form';

interface PurchaseOrderLineEditorProps {
  line: PurchaseOrderLineDraft;
  onChange: (patch: Partial<PurchaseOrderLineDraft>) => void;
  onRemove: () => void;
}

export function PurchaseOrderLineEditor({ line, onChange, onRemove }: PurchaseOrderLineEditorProps) {
  const t = useTranslations('Purchases.form');
  const tCommon = useTranslations('Common');
  const debouncedQuery = useDebouncedValue(line.productQuery, 300);
  const { data, isLoading } = useProductsQuery({ search: debouncedQuery, pageSize: 10 }, debouncedQuery.length > 0);

  const qtyNum = Number(line.qty) || 0;
  const unitPriceNum = Number(line.unitPrice) || 0;
  const lineTotal = qtyNum > 0 && unitPriceNum > 0 ? qtyNum * unitPriceNum : null;

  function selectProduct(product: Product | null) {
    onChange({ product });
  }

  return (
    <div className="grid grid-cols-1 items-start gap-3 border-b border-border py-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:gap-2">
      <SearchSelect
        selected={line.product}
        onSelect={selectProduct}
        query={line.productQuery}
        onQueryChange={(q) => onChange({ productQuery: q })}
        items={data?.data ?? []}
        isLoading={isLoading}
        getId={(p) => p.id}
        getLabel={(p) => p.name}
        getDescription={(p) => p.sku}
        placeholder={t('searchProduct')}
        emptyText={t('noProducts')}
      />

      <Input
        type="number"
        min={0}
        step="0.001"
        placeholder={t('qty')}
        value={line.qty}
        onChange={(e) => onChange({ qty: e.target.value })}
      />

      <Input
        type="number"
        min={0}
        step="0.01"
        placeholder={t('unitPrice')}
        value={line.unitPrice}
        onChange={(e) => onChange({ unitPrice: e.target.value })}
      />

      <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-end">
        <span className="text-sm tabular-nums text-muted-foreground">
          {lineTotal !== null ? `${formatMoney(lineTotal)} ${tCommon('somUnit')}` : '—'}
        </span>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t('removeLine')}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}
