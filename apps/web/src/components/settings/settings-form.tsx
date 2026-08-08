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
import type { CompanySettings, UpdateSettingsInput } from '@/lib/api/settings';

function settingsSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().min(1, t('required')).max(200),
    legalName: z.string().max(200).optional().or(z.literal('')),
    phone: z.string().max(32).optional().or(z.literal('')),
    address: z.string().max(500).optional().or(z.literal('')),
    currency: z.string().length(3, t('currencyLength')),
    timezone: z.string().min(1, t('required')).max(64),
  });
}

type SettingsFormValues = z.infer<ReturnType<typeof settingsSchema>>;

interface SettingsFormProps {
  settings: CompanySettings;
  readOnly: boolean;
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (input: UpdateSettingsInput) => void;
}

export function SettingsForm({ settings, readOnly, isSubmitting, submitError, onSubmit }: SettingsFormProps) {
  const t = useTranslations('Settings.form');

  const schema = settingsSchema(t);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: settings.name,
      legalName: settings.legalName ?? '',
      phone: settings.phone ?? '',
      address: settings.address ?? '',
      currency: settings.currency,
      timezone: settings.timezone,
    },
  });

  function submit(values: SettingsFormValues) {
    onSubmit({
      name: values.name,
      legalName: values.legalName || undefined,
      phone: values.phone || undefined,
      address: values.address || undefined,
      currency: values.currency,
      timezone: values.timezone,
    });
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
          <Label htmlFor="name">{t('name')}</Label>
          <Input id="name" disabled={readOnly} {...register('name')} aria-invalid={!!errors.name} />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="legalName">{t('legalName')}</Label>
          <Input id="legalName" disabled={readOnly} {...register('legalName')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">{t('phone')}</Label>
          <Input id="phone" disabled={readOnly} {...register('phone')} />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="address">{t('address')}</Label>
          <Input id="address" disabled={readOnly} {...register('address')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">{t('currency')}</Label>
          <Input id="currency" disabled={readOnly} maxLength={3} {...register('currency')} aria-invalid={!!errors.currency} />
          {errors.currency && <p className="text-sm text-destructive">{errors.currency.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="timezone">{t('timezone')}</Label>
          <Input id="timezone" disabled={readOnly} {...register('timezone')} aria-invalid={!!errors.timezone} />
          {errors.timezone && <p className="text-sm text-destructive">{errors.timezone.message}</p>}
        </div>
      </div>

      {!readOnly && (
        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('submit')}
        </Button>
      )}
    </form>
  );
}
