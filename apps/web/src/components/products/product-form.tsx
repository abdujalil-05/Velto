'use client';

import { useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Star, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import type { ProductFormInput } from '@/lib/api/products';
import type { ProductCategory } from '@/lib/api/categories';
import { useDefaultWarehouseQuery } from '@/lib/api/warehouses';
import { CategoryQuickAddDialog } from './category-quick-add-dialog';

function packagingSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().min(1, t('required')).max(50),
    qtyInBaseUnit: z.coerce.number().positive(t('required')),
    isDefault: z.boolean().optional(),
  });
}

function productSchema(t: (key: string) => string) {
  return z.object({
    sku: z.string().min(1, t('required')).max(64),
    name: z.string().min(1, t('required')).max(200),
    brand: z.string().max(200).optional().or(z.literal('')),
    baseUnit: z.string().min(1, t('required')).max(20),
    categoryId: z.string().optional().or(z.literal('')),
    price: z.coerce.number().min(0).optional(),
    initialQty: z.coerce.number().min(0).optional(),
    packagings: z.array(packagingSchema(t)).min(1, t('packagingRequired')),
  });
}

export type ProductFormValues = z.infer<ReturnType<typeof productSchema>>;

export interface ProductStockInit {
  warehouseId: string;
  qty: number;
}

interface ProductFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<ProductFormValues>;
  categories: ProductCategory[];
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: ProductFormInput, stockInit?: ProductStockInit) => void;
}

const DEFAULT_PACKAGING = { name: '', qtyInBaseUnit: 1, isDefault: true };

export function ProductForm({ mode, defaultValues, categories, isSubmitting, submitError, onSubmit }: ProductFormProps) {
  const t = useTranslations('Products.form');

  const schema = productSchema(t);
  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultValues ?? { packagings: [DEFAULT_PACKAGING] },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'packagings' });
  const packagings = watch('packagings');
  const categoryId = watch('categoryId');

  const [extraCategories, setExtraCategories] = useState<ProductCategory[]>([]);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const allCategories = [...categories, ...extraCategories.filter((c) => !categories.some((existing) => existing.id === c.id))];

  // Every company has exactly one warehouse (auto-provisioned server-side —
  // there's no "pick a warehouse" step), so the only thing to ask for here
  // is how much stock to start with.
  const { data: defaultWarehouse } = useDefaultWarehouseQuery(mode === 'create');

  function submit(values: ProductFormValues) {
    const input: ProductFormInput = {
      sku: values.sku,
      name: values.name,
      brand: values.brand || undefined,
      baseUnit: values.baseUnit,
      categoryId: values.categoryId || undefined,
      price: values.price,
      packagings: values.packagings.map((p) => ({ name: p.name, qtyInBaseUnit: p.qtyInBaseUnit, isDefault: p.isDefault })),
    };
    const stockInit =
      defaultWarehouse && values.initialQty && values.initialQty > 0
        ? { warehouseId: defaultWarehouse.id, qty: values.initialQty }
        : undefined;
    onSubmit(input, stockInit);
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit(submit)} noValidate>
      {submitError && (
        <Alert variant="destructive">
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="sku">{t('sku')}</Label>
          <Input id="sku" {...register('sku')} aria-invalid={!!errors.sku} />
          {errors.sku && <p className="text-sm text-destructive">{errors.sku.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">{t('name')}</Label>
          <Input id="name" {...register('name')} aria-invalid={!!errors.name} />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="brand">{t('brand')}</Label>
          <Input id="brand" {...register('brand')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="baseUnit">{t('baseUnit')}</Label>
          <Input id="baseUnit" placeholder={t('baseUnitPlaceholder')} {...register('baseUnit')} aria-invalid={!!errors.baseUnit} />
          {errors.baseUnit && <p className="text-sm text-destructive">{errors.baseUnit.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="categoryId">{t('category')}</Label>
          <div className="flex gap-2">
            <Select
              id="categoryId"
              value={categoryId ?? ''}
              onChange={(e) => setValue('categoryId', e.target.value)}
              className="flex-1"
            >
              <option value="">—</option>
              {allCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button type="button" variant="outline" size="icon" onClick={() => setCategoryDialogOpen(true)} aria-label={t('addCategory')}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="price">{t('price')}</Label>
          <Input id="price" type="number" min={0} step="0.01" {...register('price')} />
        </div>
      </div>

      {mode === 'create' && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Label htmlFor="initialQty">{t('stockInit')}</Label>
          <Input id="initialQty" type="number" min={0} step="0.001" {...register('initialQty')} />
        </div>
      )}

      <CategoryQuickAddDialog
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        onCreated={(category) => {
          setExtraCategories((prev) => [...prev, category]);
          setValue('categoryId', category.id);
        }}
      />

      <div className="space-y-2">
        <Label>{t('packagings')}</Label>
        <div className="space-y-2 rounded-md border border-border p-3">
          {fields.map((field, index) => (
            <div key={field.id} className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[2fr_1fr_auto_auto]">
              <div>
                <Input placeholder={t('packagingName')} {...register(`packagings.${index}.name` as const)} />
                {errors.packagings?.[index]?.name && (
                  <p className="text-xs text-destructive">{errors.packagings[index]?.name?.message}</p>
                )}
              </div>
              <div>
                <Input
                  type="number"
                  min={0}
                  step="0.001"
                  placeholder={t('qtyInBaseUnit')}
                  {...register(`packagings.${index}.qtyInBaseUnit` as const)}
                />
                {errors.packagings?.[index]?.qtyInBaseUnit && (
                  <p className="text-xs text-destructive">{errors.packagings[index]?.qtyInBaseUnit?.message}</p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(packagings?.[index]?.isDefault && 'border-primary text-primary')}
                onClick={() => {
                  fields.forEach((_, i) => setValue(`packagings.${i}.isDefault`, i === index));
                }}
              >
                <Star className={cn('mr-1 h-3.5 w-3.5', packagings?.[index]?.isDefault && 'fill-primary')} />
                {t('default')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove(index)}
                disabled={fields.length <= 1}
                aria-label={t('removePackaging')}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          {errors.packagings?.root && <p className="text-sm text-destructive">{errors.packagings.root.message}</p>}
          {errors.packagings?.message && <p className="text-sm text-destructive">{errors.packagings.message}</p>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ name: '', qtyInBaseUnit: 1, isDefault: fields.length === 0 })}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('addPackaging')}
          </Button>
        </div>
      </div>

      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t(mode === 'create' ? 'submitCreate' : 'submitUpdate')}
      </Button>
    </form>
  );
}
