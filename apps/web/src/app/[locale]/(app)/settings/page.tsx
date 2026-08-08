'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth/auth-context';
import { useSettingsQuery, useUpdateSettingsMutation, type UpdateSettingsInput } from '@/lib/api/settings';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SettingsForm } from '@/components/settings/settings-form';

export default function SettingsPage() {
  const t = useTranslations('Settings');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission('settings.update');

  const { data: settings, isLoading, isError, error, refetch } = useSettingsQuery();
  const updateMutation = useUpdateSettingsMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleSubmit(input: UpdateSettingsInput) {
    setSubmitError(null);
    updateMutation.mutate(input, {
      onSuccess: () => toast.success(t('saved')),
      onError: (err) => setSubmitError(errorMessage(err, locale)),
    });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>

      {isLoading && (
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-96 w-full" />
          </CardContent>
        </Card>
      )}

      {isError && !isLoading && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {settings && (
        <Card>
          <CardContent className="pt-6">
            <SettingsForm
              settings={settings}
              readOnly={!canUpdate}
              isSubmitting={updateMutation.isPending}
              submitError={submitError}
              onSubmit={handleSubmit}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
