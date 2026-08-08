'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useCreatePurchaseOrderMutation } from '@/lib/api/purchase-orders';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PurchaseOrderForm } from '@/components/purchases/purchase-order-form';

export default function NewPurchaseOrderPage() {
  const t = useTranslations('Purchases.form');
  const locale = useLocale();
  const router = useRouter();
  const createMutation = useCreatePurchaseOrderMutation();

  const [submitError, setSubmitError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Link href="/purchases" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <Card className="mx-auto max-w-3xl">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PurchaseOrderForm
            isSubmitting={createMutation.isPending}
            submitError={submitError}
            onSubmit={(input) => {
              setSubmitError(null);
              createMutation.mutate(input, {
                onSuccess: (po) => {
                  toast.success(t('created'));
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
