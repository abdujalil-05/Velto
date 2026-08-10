'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { useCustomerQuery, useCustomersQuery, type Customer } from '@/lib/api/customers';
import { useDefaultWarehouseQuery } from '@/lib/api/warehouses';
import { usePriceListItemsQuery } from '@/lib/api/price-lists';
import { useSuppliersQuery } from '@/lib/api/suppliers';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import type { Product } from '@/lib/api/products';
import type { CreateOrderInput } from '@/lib/api/orders';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SearchSelect } from '@/components/shared/search-select';
import { OrderLineEditor } from './order-line-editor';

export interface OrderLineDraft {
  key: string;
  product: Product | null;
  productQuery: string;
  packagingId: string;
  qty: string;
  discountPct: string;
}

function emptyLine(): OrderLineDraft {
  return { key: crypto.randomUUID(), product: null, productQuery: '', packagingId: '', qty: '', discountPct: '' };
}

interface OrderFormProps {
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: CreateOrderInput) => void;
}

export function OrderForm({ isSubmitting, submitError, onSubmit }: OrderFormProps) {
  const t = useTranslations('Orders.form');

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const debouncedCustomerQuery = useDebouncedValue(customerQuery, 300);
  const { data: customerOptions, isLoading: customersLoading } = useCustomersQuery({
    page: 1,
    pageSize: 10,
    search: debouncedCustomerQuery || undefined,
  });
  const { data: customerDetail } = useCustomerQuery(customer?.id ?? '');

  const [outletId, setOutletId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<OrderLineDraft[]>([emptyLine()]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const { data: suppliers, isLoading: suppliersLoading } = useSuppliersQuery({ pageSize: 100 });

  // Single-warehouse-per-company model — no picker, just the one warehouse.
  const { data: warehouse } = useDefaultWarehouseQuery();
  const warehouseId = warehouse?.id;

  const { data: priceItems } = usePriceListItemsQuery(customerDetail?.priceListId ?? null);
  const priceByProductId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of priceItems?.data ?? []) map.set(item.productId, item.price);
    return map;
  }, [priceItems]);

  function updateLine(key: string, patch: Partial<OrderLineDraft>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : prev));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!customer) {
      setValidationError(t('selectCustomerFirst'));
      return;
    }

    const validLines = lines.filter((line) => line.product && line.packagingId && Number(line.qty) > 0);
    if (validLines.length === 0) {
      setValidationError(t('emptyLinesError'));
      return;
    }

    onSubmit({
      customerId: customer.id,
      outletId: outletId || undefined,
      warehouseId: warehouseId || undefined,
      supplierId: supplierId || undefined,
      note: note.trim() || undefined,
      lines: validLines.map((line) => ({
        productId: line.product!.id,
        packagingId: line.packagingId,
        qty: Number(line.qty),
        discountPct: line.discountPct ? Number(line.discountPct) : undefined,
      })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t('customer')}</Label>
          <SearchSelect
            selected={customer}
            onSelect={(c) => {
              setCustomer(c);
              setOutletId('');
            }}
            query={customerQuery}
            onQueryChange={setCustomerQuery}
            items={customerOptions?.data ?? []}
            isLoading={customersLoading}
            getId={(c) => c.id}
            getLabel={(c) => c.name}
            getDescription={(c) => c.code}
            placeholder={t('searchCustomer')}
            emptyText={t('noCustomers')}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="outlet">
            {t('outlet')} <span className="text-xs text-muted-foreground">({t('outletOptional')})</span>
          </Label>
          <Select id="outlet" value={outletId} onChange={(e) => setOutletId(e.target.value)} disabled={!customerDetail}>
            <option value="">—</option>
            {customerDetail?.outlets.map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="supplier">
            {t('supplier')} <span className="text-xs text-muted-foreground">({t('supplierOptional')})</span>
          </Label>
          <Select id="supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={suppliersLoading}>
            <option value="">—</option>
            {suppliers?.data.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </Select>
          {supplierId && <p className="text-xs text-muted-foreground">{t('supplierHint')}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t('lines')}</Label>
        <div className="rounded-md border border-border">
          {lines.map((line) => (
            <div key={line.key} className="px-3">
              <OrderLineEditor
                line={line}
                onChange={(patch) => updateLine(line.key, patch)}
                onRemove={() => removeLine(line.key)}
                warehouseId={warehouseId || null}
                priceByProductId={priceByProductId}
              />
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
          <Plus className="mr-2 h-4 w-4" />
          {t('addLine')}
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="note">{t('note')}</Label>
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
