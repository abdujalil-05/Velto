'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { useSuppliersQuery, type Supplier } from '@/lib/api/suppliers';
import { useWarehousesQuery } from '@/lib/api/warehouses';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import type { Product } from '@/lib/api/products';
import type { CreatePurchaseOrderInput } from '@/lib/api/purchase-orders';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SearchSelect } from '@/components/shared/search-select';
import { PurchaseOrderLineEditor } from './purchase-order-line-editor';
import { SupplierQuickAddDialog } from './supplier-quick-add-dialog';

export interface PurchaseOrderLineDraft {
  key: string;
  product: Product | null;
  productQuery: string;
  qty: string;
  unitPrice: string;
}

function emptyLine(): PurchaseOrderLineDraft {
  return { key: crypto.randomUUID(), product: null, productQuery: '', qty: '', unitPrice: '' };
}

interface PurchaseOrderFormProps {
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: CreatePurchaseOrderInput) => void;
}

export function PurchaseOrderForm({ isSubmitting, submitError, onSubmit }: PurchaseOrderFormProps) {
  const t = useTranslations('Purchases.form');

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [supplierQuery, setSupplierQuery] = useState('');
  const debouncedSupplierQuery = useDebouncedValue(supplierQuery, 300);
  const { data: supplierOptions, isLoading: suppliersLoading } = useSuppliersQuery({
    page: 1,
    pageSize: 10,
    search: debouncedSupplierQuery || undefined,
  });
  const [supplierDialogOpen, setSupplierDialogOpen] = useState(false);

  const { data: warehouses } = useWarehousesQuery();
  const activeWarehouses = (warehouses ?? []).filter((w) => w.isActive);
  const [warehouseId, setWarehouseId] = useState('');
  useEffect(() => {
    if (activeWarehouses.length === 1 && !warehouseId) setWarehouseId(activeWarehouses[0]!.id);
  }, [activeWarehouses, warehouseId]);

  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PurchaseOrderLineDraft[]>([emptyLine()]);
  const [validationError, setValidationError] = useState<string | null>(null);

  function updateLine(key: string, patch: Partial<PurchaseOrderLineDraft>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : prev));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!supplier) {
      setValidationError(t('selectSupplierFirst'));
      return;
    }
    if (!warehouseId) {
      setValidationError(t('selectWarehouseFirst'));
      return;
    }

    const validLines = lines.filter((line) => line.product && Number(line.qty) > 0 && Number(line.unitPrice) > 0);
    if (validLines.length === 0) {
      setValidationError(t('emptyLinesError'));
      return;
    }

    onSubmit({
      supplierId: supplier.id,
      warehouseId,
      note: note.trim() || undefined,
      lines: validLines.map((line) => ({
        productId: line.product!.id,
        qty: Number(line.qty),
        unitPrice: Number(line.unitPrice),
      })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>{t('supplier')}</Label>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSupplierDialogOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('newSupplier')}
            </Button>
          </div>
          <SearchSelect
            selected={supplier}
            onSelect={setSupplier}
            query={supplierQuery}
            onQueryChange={setSupplierQuery}
            items={supplierOptions?.data ?? []}
            isLoading={suppliersLoading}
            getId={(s) => s.id}
            getLabel={(s) => s.name}
            getDescription={(s) => s.phone ?? undefined}
            placeholder={t('searchSupplier')}
            emptyText={t('noSuppliers')}
          />
        </div>

        {activeWarehouses.length > 1 && (
          <div className="space-y-2">
            <Label htmlFor="warehouse">{t('warehouse')}</Label>
            <Select id="warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">—</option>
              {activeWarehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>{t('lines')}</Label>
        <div className="rounded-md border border-border">
          {lines.map((line) => (
            <div key={line.key} className="px-3">
              <PurchaseOrderLineEditor line={line} onChange={(patch) => updateLine(line.key, patch)} onRemove={() => removeLine(line.key)} />
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

      <SupplierQuickAddDialog
        open={supplierDialogOpen}
        onOpenChange={setSupplierDialogOpen}
        onCreated={(created) => setSupplier(created)}
      />
    </form>
  );
}
