'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { CustomerFormInput, OutletType } from '@/lib/api/customers';

const OUTLET_TYPES: OutletType[] = ['SHOP', 'MINIMARKET', 'SUPERMARKET', 'BAZAAR', 'HORECA', 'WAREHOUSE', 'OTHER'];

function customerSchema(t: (key: string) => string) {
  return z.object({
    code: z.string().min(1, t('required')).max(64),
    name: z.string().min(1, t('required')).max(200),
    phone: z.string().max(32).optional().or(z.literal('')),
    contactPerson: z.string().max(200).optional().or(z.literal('')),
    priceListId: z.string().optional().or(z.literal('')),
    paymentTermDays: z.coerce.number().int().min(0).optional(),
    outletName: z.string().max(200).optional().or(z.literal('')),
    outletType: z.string().optional(),
    outletAddress: z.string().max(500).optional().or(z.literal('')),
  });
}

export type CustomerFormValues = z.infer<ReturnType<typeof customerSchema>>;

interface CustomerFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<CustomerFormValues>;
  priceLists: { id: string; name: string }[];
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: CustomerFormInput) => void;
}

export function CustomerForm({ mode, defaultValues, priceLists, isSubmitting, submitError, onSubmit }: CustomerFormProps) {
  const t = useTranslations('Customers.form');

  const schema = customerSchema(t);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  function submit(values: CustomerFormValues) {
    const input: CustomerFormInput = {
      code: values.code,
      name: values.name,
      phone: values.phone || undefined,
      contactPerson: values.contactPerson || undefined,
      priceListId: values.priceListId || undefined,
      paymentTermDays: values.paymentTermDays,
      outlets:
        mode === 'create' && values.outletName?.trim()
          ? [{ name: values.outletName.trim(), type: (values.outletType as OutletType) || undefined, address: values.outletAddress || undefined }]
          : undefined,
    };
    onSubmit(input);
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
          <Label htmlFor="code">{t('code')}</Label>
          <Input id="code" {...register('code')} aria-invalid={!!errors.code} />
          {errors.code && <p className="text-sm text-destructive">{errors.code.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">{t('name')}</Label>
          <Input id="name" {...register('name')} aria-invalid={!!errors.name} />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">{t('phone')}</Label>
          <Input id="phone" {...register('phone')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="contactPerson">{t('contactPerson')}</Label>
          <Input id="contactPerson" {...register('contactPerson')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="priceListId">{t('priceList')}</Label>
          <Select id="priceListId" {...register('priceListId')} defaultValue="">
            <option value="">{t('priceListDefault')}</option>
            {priceLists.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="paymentTermDays">{t('paymentTermDays')}</Label>
          <Input id="paymentTermDays" type="number" min={0} step="1" {...register('paymentTermDays')} />
        </div>
      </div>

      {mode === 'create' && (
        <div className="space-y-4 rounded-md border border-border p-4">
          <div>
            <p className="text-sm font-medium">{t('firstOutlet')}</p>
            <p className="text-xs text-muted-foreground">{t('firstOutletHint')}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="outletName">{t('outletName')}</Label>
              <Input id="outletName" {...register('outletName')} aria-invalid={!!errors.outletName} />
              {errors.outletName && <p className="text-sm text-destructive">{errors.outletName.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="outletType">{t('outletType')}</Label>
              <Select id="outletType" {...register('outletType')} defaultValue="SHOP">
                {OUTLET_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`outletTypes.${type}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="outletAddress">{t('outletAddress')}</Label>
              <Input id="outletAddress" {...register('outletAddress')} />
            </div>
          </div>
        </div>
      )}

      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t(mode === 'create' ? 'submitCreate' : 'submitUpdate')}
      </Button>
    </form>
  );
}
