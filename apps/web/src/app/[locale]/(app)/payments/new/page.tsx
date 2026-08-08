'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useCreatePaymentMutation } from '@/lib/api/payments';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PaymentForm } from '@/components/payments/payment-form';

export default function NewPaymentPage() {
  const t = useTranslations('Payments.form');
  const locale = useLocale();
  const router = useRouter();
  const createMutation = useCreatePaymentMutation();

  const [submitError, setSubmitError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Link href="/cash" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PaymentForm
            isSubmitting={createMutation.isPending}
            submitError={submitError}
            onSubmit={(input) => {
              setSubmitError(null);
              createMutation.mutate(input, {
                onSuccess: () => {
                  toast.success(t('created'));
                  router.push('/cash');
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
