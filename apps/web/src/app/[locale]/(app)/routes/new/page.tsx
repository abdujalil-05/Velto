'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useCreateRouteMutation, type RouteInput } from '@/lib/api/routes';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { RouteForm } from '@/components/routes/route-form';

export default function NewRoutePage() {
  const t = useTranslations('Routes.form');
  const locale = useLocale();
  const router = useRouter();
  const createMutation = useCreateRouteMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleSubmit(input: RouteInput) {
    setSubmitError(null);
    createMutation.mutate(input, {
      onSuccess: () => {
        toast.success(t('created'));
        router.push('/routes');
      },
      onError: (err) => setSubmitError(errorMessage(err, locale)),
    });
  }

  return (
    <div className="space-y-4">
      <Link href="/routes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <h1 className="text-xl font-semibold">{t('title')}</h1>

      <Card>
        <CardContent className="pt-6">
          <RouteForm mode="create" isSubmitting={createMutation.isPending} submitError={submitError} onSubmit={handleSubmit} />
        </CardContent>
      </Card>
    </div>
  );
}
