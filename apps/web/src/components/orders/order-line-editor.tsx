'use client';

import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchSelect } from '@/components/shared/search-select';
import { Button } from '@/components/ui/button';
import { useProductsQuery, type Product } from '@/lib/api/products';
import { useStockAvailabilityQuery } from '@/lib/api/stock';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { formatMoney, formatQty } from '@/lib/format';
import type { OrderLineDraft } from './order-form';

interface OrderLineEditorProps {
  line: OrderLineDraft;
  onChange: (patch: Partial<OrderLineDraft>) => void;
  onRemove: () => void;
  warehouseId: string | null;
  priceByProductId: Map<string, string>;
}

export function OrderLineEditor({ line, onChange, onRemove, warehouseId, priceByProductId }: OrderLineEditorProps) {
  const t = useTranslations('Orders.form');
  const tCommon = useTranslations('Common');
  const debouncedQuery = useDebouncedValue(line.productQuery, 300);
  const { data, isLoading } = useProductsQuery({ search: debouncedQuery, pageSize: 10 }, debouncedQuery.length > 0);

  const availability = useStockAvailabilityQuery(line.product?.id ?? null, warehouseId);

  const selectedPackaging = line.product?.packagings.find((p) => p.id === line.packagingId);
  const unitPrice = line.product ? priceByProductId.get(line.product.id) : undefined;
  const qtyNum = Number(line.qty) || 0;
  const discountNum = Number(line.discountPct) || 0;

  let estimatedTotal: number | null = null;
  if (line.product && selectedPackaging && unitPrice && qtyNum > 0) {
    const baseQty = qtyNum * Number(selectedPackaging.qtyInBaseUnit);
    const vatRate = Number(line.product.vatRate);
    estimatedTotal = baseQty * Number(unitPrice) * (1 - discountNum / 100) * (1 + vatRate / 100);
  }

  function selectProduct(product: Product | null) {
    const defaultPackaging = product?.packagings.find((p) => p.isDefault) ?? product?.packagings[0];
    onChange({ product, packagingId: defaultPackaging?.id ?? '' });
  }

  return (
    <div className="grid grid-cols-1 items-start gap-3 border-b border-border py-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:gap-2">
      <div>
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
        {line.product && warehouseId && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('available')}: {availability.isLoading ? '…' : availability.data !== undefined ? formatQty(availability.data) : '—'}
          </p>
        )}
      </div>

      <Select
        value={line.packagingId}
        onChange={(e) => onChange({ packagingId: e.target.value })}
        disabled={!line.product}
      >
        {!line.product && <option value="">—</option>}
        {line.product?.packagings.map((pkg) => (
          <option key={pkg.id} value={pkg.id}>
            {pkg.name}
          </option>
        ))}
      </Select>

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
        max={100}
        step="1"
        placeholder={t('discountPct')}
        value={line.discountPct}
        onChange={(e) => onChange({ discountPct: e.target.value })}
      />

      <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-end">
        <span className="text-sm tabular-nums text-muted-foreground">
          {estimatedTotal !== null ? `≈ ${formatMoney(estimatedTotal)} ${tCommon('somUnit')}` : '—'}
        </span>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t('removeLine')}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}
