'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, Trash2 } from 'lucide-react';
import { useProductsQuery, type Product } from '@/lib/api/products';
import { useSuppliersQuery, type PurchaseOrderInput } from '@/lib/api/purchases';
import { useWarehousesQuery } from '@/lib/api/warehouses';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SearchSelect } from '@/components/shared/search-select';

interface Line {
  product: Product;
  qty: string;
  unitPrice: string;
}

interface PoFormProps {
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: PurchaseOrderInput) => void;
}

const QTY_RE = /^\d+(\.\d{1,3})?$/;
const PRICE_RE = /^\d+(\.\d{1,2})?$/;

export function PoForm({ isSubmitting, submitError, onSubmit }: PoFormProps) {
  const t = useTranslations('Purchases.orderForm');
  const { data: suppliers } = useSuppliersQuery({ pageSize: 100, isActive: true });
  const { data: warehouses } = useWarehousesQuery();

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [productQuery, setProductQuery] = useState('');
  const debouncedQuery = useDebouncedValue(productQuery, 300);
  const { data: productOptions, isLoading: productsLoading } = useProductsQuery(
    { search: debouncedQuery, pageSize: 10 },
    debouncedQuery.length > 0,
  );

  const activeWarehouses = warehouses?.filter((w) => w.isActive) ?? [];
  // Single-warehouse companies: preselect without a picker interaction.
  const effectiveWarehouseId = warehouseId || (activeWarehouses.length === 1 ? activeWarehouses[0].id : '');

  function addProduct(product: Product | null) {
    if (!product) return;
    setProductQuery('');
    setLines((prev) =>
      prev.some((l) => l.product.id === product.id)
        ? prev
        : [...prev, { product, qty: '', unitPrice: '' }],
    );
  }

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function submit(e: FormEvent, status: 'DRAFT' | 'ORDERED') {
    e.preventDefault();
    setError(null);
    if (!supplierId) return setError(t('selectSupplier'));
    if (!effectiveWarehouseId) return setError(t('selectWarehouse'));
    if (lines.length === 0) return setError(t('addLine'));
    for (const l of lines) {
      if (!QTY_RE.test(l.qty) || Number(l.qty) <= 0) return setError(t('invalidQty', { name: l.product.name }));
      if (!PRICE_RE.test(l.unitPrice)) return setError(t('invalidPrice', { name: l.product.name }));
    }
    onSubmit({
      supplierId,
      warehouseId: effectiveWarehouseId,
      status,
      expectedAt: expectedAt || undefined,
      note: note.trim() || undefined,
      lines: lines.map((l) => ({ productId: l.product.id, qty: Number(l.qty), unitPrice: Number(l.unitPrice) })),
    });
  }

  const shownError = error ?? submitError;

  return (
    <form onSubmit={(e) => submit(e, 'DRAFT')} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="po-supplier">{t('supplier')}</Label>
          <Select id="po-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">{t('chooseSupplier')}</option>
            {suppliers?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="po-warehouse">{t('warehouse')}</Label>
          <Select id="po-warehouse" value={effectiveWarehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">{t('chooseWarehouse')}</option>
            {activeWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="po-expected">{t('expectedAt')}</Label>
          <Input id="po-expected" type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
        </div>
      </div>

      <div className="space-y-3">
        <Label>{t('lines')}</Label>
        <SearchSelect
          selected={null}
          onSelect={addProduct}
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

        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noLines')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">{t('product')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('qty')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('unitPrice')}</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((l, i) => (
                  <tr key={l.product.id}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{l.product.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {l.product.sku} · {l.product.baseUnit}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.001"
                        className="w-28"
                        aria-label={t('qty')}
                        value={l.qty}
                        onChange={(e) => updateLine(i, { qty: e.target.value })}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        className="w-32"
                        aria-label={t('unitPrice')}
                        value={l.unitPrice}
                        onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                      />
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('removeLine')}
                        onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('totalsHint')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="po-note">{t('note')}</Label>
        <Textarea id="po-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {shownError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {shownError}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={isSubmitting}>
          {t('saveDraft')}
        </Button>
        <Button type="button" disabled={isSubmitting} onClick={(e) => submit(e, 'ORDERED')}>
          {t('saveAndOrder')}
        </Button>
      </div>
    </form>
  );
}
