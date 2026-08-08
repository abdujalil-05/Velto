'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useProductsQuery, type Product } from '@/lib/api/products';
import { useDefaultWarehouseQuery } from '@/lib/api/warehouses';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import type { ReceiveStockInput } from '@/lib/api/stock';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SearchSelect } from '@/components/shared/search-select';

interface ReceiveStockFormProps {
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: ReceiveStockInput) => void;
}

export function ReceiveStockForm({ isSubmitting, submitError, onSubmit }: ReceiveStockFormProps) {
  const t = useTranslations('Stock.receiveForm');

  const [product, setProduct] = useState<Product | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const debouncedProductQuery = useDebouncedValue(productQuery, 300);
  const { data: productOptions, isLoading: productsLoading } = useProductsQuery(
    { search: debouncedProductQuery, pageSize: 10 },
    debouncedProductQuery.length > 0,
  );

  // Single-warehouse-per-company model — no picker, just the one warehouse.
  const { data: warehouse } = useDefaultWarehouseQuery();

  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!product) {
      setValidationError(t('selectProductFirst'));
      return;
    }
    if (!warehouse) {
      setValidationError(t('selectWarehouseFirst'));
      return;
    }
    const qtyNum = Number(qty);
    if (!qtyNum || qtyNum <= 0) {
      setValidationError(t('invalidQty'));
      return;
    }

    onSubmit({ productId: product.id, warehouseId: warehouse.id, qty: qtyNum, note: note.trim() || undefined });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label>{t('product')}</Label>
        <SearchSelect
          selected={product}
          onSelect={setProduct}
          query={productQuery}
          onQueryChange={setProductQuery}
          items={productOptions?.data ?? []}
          isLoading={productsLoading}
          getId={(p) => p.id}
          getLabel={(p) => p.name}
          getDescription={(p) => p.sku}
          placeholder={t('searchProduct')}
          emptyText={t('noProducts')}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="qty">{t('qty')}</Label>
        <Input id="qty" type="number" min={0} step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="note">{t('reason')}</Label>
        <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {(validationError || submitError) && (
        <Alert variant="destructive">
          <AlertDescription>{validationError ?? submitError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {t('submit')}
      </Button>
    </form>
  );
}
