'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useReceiveStockMutation } from '@/lib/api/stock';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReceiveStockForm } from '@/components/stock/receive-stock-form';

export default function ReceiveStockPage() {
  const t = useTranslations('Stock.receiveForm');
  const locale = useLocale();
  const router = useRouter();
  const receiveMutation = useReceiveStockMutation();

  const [submitError, setSubmitError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Link href="/stock" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ReceiveStockForm
            isSubmitting={receiveMutation.isPending}
            submitError={submitError}
            onSubmit={(input) => {
              setSubmitError(null);
              receiveMutation.mutate(input, {
                onSuccess: () => {
                  toast.success(t('received'));
                  router.push('/stock');
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
