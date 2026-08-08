'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { CreateWarehouseInput } from '@/lib/api/warehouses';

function warehouseSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().min(1, t('required')).max(200),
    address: z.string().max(500).optional().or(z.literal('')),
  });
}

type WarehouseFormValues = z.infer<ReturnType<typeof warehouseSchema>>;

interface WarehouseStepFormProps {
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: CreateWarehouseInput) => void;
}

export function WarehouseStepForm({ isSubmitting, submitError, onSubmit }: WarehouseStepFormProps) {
  const t = useTranslations('Onboarding.warehouse');

  const schema = warehouseSchema(t);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<WarehouseFormValues>({ resolver: zodResolver(schema) });

  function submit(values: WarehouseFormValues) {
    onSubmit({ name: values.name, address: values.address || undefined });
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit(submit)} noValidate>
      {submitError && (
        <Alert variant="destructive">
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="warehouseName">{t('name')}</Label>
        <Input id="warehouseName" {...register('name')} aria-invalid={!!errors.name} autoFocus />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="warehouseAddress">{t('address')}</Label>
        <Input id="warehouseAddress" {...register('address')} />
      </div>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('submit')}
      </Button>
    </form>
  );
}
