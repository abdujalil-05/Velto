'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useCreatePurchaseOrderMutation } from '@/lib/api/purchases';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PoForm } from '@/components/purchases/po-form';
import { NoPermission } from '@/components/purchases/no-permission';

export default function NewPurchaseOrderPage() {
  const t = useTranslations('Purchases');
  const locale = useLocale();
  const router = useRouter();
  const { hasPermission } = useAuth();
  const mutation = useCreatePurchaseOrderMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!hasPermission('purchases.create')) return <NoPermission />;

  return (
    <div className="space-y-4">
      <Link href="/purchases" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>
      <Card className="mx-auto max-w-4xl">
        <CardHeader>
          <CardTitle>{t('newOrder')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PoForm
            isSubmitting={mutation.isPending}
            submitError={submitError}
            onSubmit={(input) => {
              setSubmitError(null);
              mutation.mutate(input, {
                onSuccess: (po) => {
                  toast.success(t('orderCreated', { number: po.number }));
                  router.push(`/purchases/${po.id}`);
                },
                onError: (error) => setSubmitError(errorMessage(error, locale)),
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
