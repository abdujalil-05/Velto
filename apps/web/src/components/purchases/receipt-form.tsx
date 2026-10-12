'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, Trash2 } from 'lucide-react';
import { useProductsQuery, type Product } from '@/lib/api/products';
import { useSuppliersQuery, type GoodsReceiptInput, type PurchaseOrderDetail } from '@/lib/api/purchases';
import { useWarehousesQuery } from '@/lib/api/warehouses';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { qtyExceeds, remainingQty } from '@/lib/decimal-qty';
import { formatQty } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SearchSelect } from '@/components/shared/search-select';

interface ReceiptFormProps {
  /** Present = receive against this PO (prefilled remaining qty). */
  po: PurchaseOrderDetail | null;
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: GoodsReceiptInput) => void;
}

interface PoLineState {
  lineId: string;
  name: string;
  sku: string;
  unit: string;
  remaining: string;
  qty: string;
}

interface AdhocLine {
  product: Product;
  qty: string;
  unitCost: string;
}

const QTY_RE = /^\d+(\.\d{1,3})?$/;
const PRICE_RE = /^\d+(\.\d{1,2})?$/;

export function ReceiptForm({ po, isSubmitting, submitError, onSubmit }: ReceiptFormProps) {
  const t = useTranslations('Purchases.receiptForm');
  // Idempotency key is reused only for a resend of the identical payload (network retry); any edit gets a fresh one.
  const keyRef = useRef<{ sig: string; id: string } | null>(null);
  function clientIdFor(payload: unknown): string {
    const sig = JSON.stringify(payload);
    if (keyRef.current?.sig !== sig) keyRef.current = { sig, id: crypto.randomUUID() };
    return keyRef.current.id;
  }

  const { data: suppliers } = useSuppliersQuery({ pageSize: 100, isActive: true }, !po);
  const { data: warehouses } = useWarehousesQuery(!po);
  const activeWarehouses = warehouses?.filter((w) => w.isActive) ?? [];

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const initialPoLines = useMemo<PoLineState[]>(
    () =>
      (po?.lines ?? [])
        .map((l) => {
          const remaining = remainingQty(l.qty, l.qtyReceived);
          return { lineId: l.id, name: l.productName, sku: l.productSku, unit: l.unit, remaining, qty: remaining };
        })
        .filter((l) => Number(l.remaining) > 0),
    [po],
  );
  const [poLines, setPoLines] = useState<PoLineState[] | null>(null);
  const shownPoLines = poLines ?? initialPoLines;

  const [adhoc, setAdhoc] = useState<AdhocLine[]>([]);
  const [productQuery, setProductQuery] = useState('');
  const debouncedQuery = useDebouncedValue(productQuery, 300);
  const { data: productOptions, isLoading: productsLoading } = useProductsQuery(
    { search: debouncedQuery, pageSize: 10 },
    !po && debouncedQuery.length > 0,
  );

  const effectiveWarehouseId = warehouseId || (activeWarehouses.length === 1 ? activeWarehouses[0].id : '');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (po) {
      const lines = shownPoLines.filter((l) => l.qty !== '' && Number(l.qty) !== 0);
      if (lines.length === 0) return setError(t('nothingToReceive'));
      for (const l of lines) {
        if (!QTY_RE.test(l.qty) || Number(l.qty) <= 0) return setError(t('invalidQty', { name: l.name }));
        if (qtyExceeds(l.qty, l.remaining)) {
          return setError(t('exceedsRemaining', { name: l.name, remaining: formatQty(l.remaining) }));
        }
      }
      const body = {
        purchaseOrderId: po.id,
        note: note.trim() || undefined,
        lines: lines.map((l) => ({ purchaseOrderLineId: l.lineId, qty: Number(l.qty) })),
      };
      onSubmit({ clientId: clientIdFor(body), ...body });
      return;
    }

    if (!effectiveWarehouseId) return setError(t('selectWarehouse'));
    if (adhoc.length === 0) return setError(t('addLine'));
    for (const l of adhoc) {
      if (!QTY_RE.test(l.qty) || Number(l.qty) <= 0) return setError(t('invalidQty', { name: l.product.name }));
      if (l.unitCost !== '' && !PRICE_RE.test(l.unitCost)) return setError(t('invalidCost', { name: l.product.name }));
    }
    const body = {
      warehouseId: effectiveWarehouseId,
      supplierId: supplierId || undefined,
      note: note.trim() || undefined,
      lines: adhoc.map((l) => ({
        productId: l.product.id,
        qty: Number(l.qty),
        unitCost: l.unitCost === '' ? undefined : Number(l.unitCost),
      })),
    };
    onSubmit({ clientId: clientIdFor(body), ...body });
  }

  const shownError = error ?? submitError;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {po ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t('fromOrder', { number: po.number, supplier: po.supplier.name, warehouse: po.warehouse.name })}
          </p>
          {shownPoLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('fullyReceived')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('product')}</th>
                    <th className="pb-2 pr-3 text-right font-medium">{t('remaining')}</th>
                    <th className="pb-2 font-medium">{t('qtyNow')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shownPoLines.map((l, i) => (
                    <tr key={l.lineId}>
                      <td className="py-2 pr-3">
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs text-muted-foreground">{l.sku}</div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatQty(l.remaining)} {l.unit}
                      </td>
                      <td className="py-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.001"
                          className="w-32"
                          aria-label={t('qtyNow')}
                          value={l.qty}
                          onChange={(e) =>
                            setPoLines(shownPoLines.map((x, idx) => (idx === i ? { ...x, qty: e.target.value } : x)))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rc-warehouse">{t('warehouse')}</Label>
              <Select id="rc-warehouse" value={effectiveWarehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">{t('chooseWarehouse')}</option>
                {activeWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rc-supplier">{t('supplierOptional')}</Label>
              <Select id="rc-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">{t('noSupplier')}</option>
                {suppliers?.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            <Label>{t('lines')}</Label>
            <SearchSelect
              selected={null}
              onSelect={(p) => {
                if (!p) return;
                setProductQuery('');
                setAdhoc((prev) => (prev.some((l) => l.product.id === p.id) ? prev : [...prev, { product: p, qty: '', unitCost: '' }]));
              }}
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
            {adhoc.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noLines')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">{t('product')}</th>
                      <th className="pb-2 pr-3 font-medium">{t('qtyNow')}</th>
                      <th className="pb-2 pr-3 font-medium">{t('unitCost')}</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {adhoc.map((l, i) => (
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
                            aria-label={t('qtyNow')}
                            value={l.qty}
                            onChange={(e) => setAdhoc((prev) => prev.map((x, idx) => (idx === i ? { ...x, qty: e.target.value } : x)))}
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            step="0.01"
                            className="w-32"
                            aria-label={t('unitCost')}
                            value={l.unitCost}
                            onChange={(e) => setAdhoc((prev) => prev.map((x, idx) => (idx === i ? { ...x, unitCost: e.target.value } : x)))}
                          />
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t('removeLine')}
                            onClick={() => setAdhoc((prev) => prev.filter((_, idx) => idx !== i))}
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
          </div>
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor="rc-note">{t('note')}</Label>
        <Textarea id="rc-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {shownError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {shownError}
          </AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={isSubmitting || (!!po && shownPoLines.length === 0)}>
        {t('submit')}
      </Button>
    </form>
  );
}
