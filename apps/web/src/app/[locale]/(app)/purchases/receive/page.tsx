'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import { useCreateGoodsReceiptMutation, usePurchaseOrderQuery } from '@/lib/api/purchases';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ReceiptForm } from '@/components/purchases/receipt-form';
import { NoPermission } from '@/components/purchases/no-permission';

function ReceivePageInner() {
  const t = useTranslations('Purchases');
  const locale = useLocale();
  const router = useRouter();
  const { hasPermission } = useAuth();
  const poId = useSearchParams().get('po') ?? '';
  const canReceive = hasPermission('purchases.receive');

  const poQuery = usePurchaseOrderQuery(canReceive ? poId : '');
  const mutation = useCreateGoodsReceiptMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!canReceive) return <NoPermission />;

  return (
    <div className="space-y-4">
      <Link
        href={poId ? `/purchases/${poId}` : '/purchases'}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <Card className="mx-auto max-w-4xl">
        <CardHeader>
          <CardTitle>{t('newReceipt')}</CardTitle>
        </CardHeader>
        <CardContent>
          {poId && poQuery.isLoading && (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}
          {poId && poQuery.isError && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {errorMessage(poQuery.error, locale)}
                </span>
                <Button variant="outline" size="sm" onClick={() => poQuery.refetch()}>
                  {t('retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {(!poId || poQuery.data) && (
            <ReceiptForm
              po={poId ? (poQuery.data ?? null) : null}
              isSubmitting={mutation.isPending}
              submitError={submitError}
              onSubmit={(input) => {
                setSubmitError(null);
                mutation.mutate(input, {
                  onSuccess: () => {
                    toast.success(t('receiptCreated'));
                    router.push(poId ? `/purchases/${poId}` : '/stock');
                  },
                  onError: (error) => setSubmitError(errorMessage(error, locale)),
                });
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ReceivePage() {
  return (
    <Suspense fallback={null}>
      <ReceivePageInner />
    </Suspense>
  );
}
