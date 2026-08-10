'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useRouteQuery, useUpdateRouteMutation, type RouteInput } from '@/lib/api/routes';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { RouteForm } from '@/components/routes/route-form';

export default function EditRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Routes.form');
  const locale = useLocale();
  const router = useRouter();

  const { data: route, isLoading, isError, error, refetch } = useRouteQuery(id);
  const updateMutation = useUpdateRouteMutation(id);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleSubmit(input: RouteInput) {
    setSubmitError(null);
    updateMutation.mutate(input, {
      onSuccess: () => {
        toast.success(t('updated'));
        router.push('/routes');
      },
      onError: (err) => setSubmitError(errorMessage(err, locale)),
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !route) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{errorMessage(error, locale)}</span>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/routes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <h1 className="text-xl font-semibold">{route.name}</h1>

      <Card>
        <CardContent className="pt-6">
          <RouteForm
            mode="edit"
            defaultValues={{
              agentId: route.agentId ?? undefined,
              supplierId: route.supplierId ?? undefined,
              weekday: route.weekday,
              name: route.name,
              stops: route.stops.map((s) => ({
                outletId: s.outletId,
                outletName: s.outlet.name,
                customerName: '',
                address: s.outlet.address,
              })),
            }}
            isSubmitting={updateMutation.isPending}
            submitError={submitError}
            onSubmit={handleSubmit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
