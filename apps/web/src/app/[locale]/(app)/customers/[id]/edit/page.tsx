'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useCustomerQuery, useUpdateCustomerMutation } from '@/lib/api/customers';
import { usePriceListsQuery } from '@/lib/api/price-lists';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CustomerForm } from '@/components/customers/customer-form';

export default function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Customers.form');
  const locale = useLocale();
  const router = useRouter();

  const { data: customer, isLoading, isError, error, refetch } = useCustomerQuery(id);
  const { data: priceListsData } = usePriceListsQuery();
  const updateMutation = useUpdateCustomerMutation(id);
  const [submitError, setSubmitError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Link href={`/customers/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToDetail')}
      </Link>

      {isLoading && <Skeleton className="mx-auto h-96 max-w-2xl" />}

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

      {customer && (
        <Card className="mx-auto max-w-2xl">
          <CardHeader>
            <CardTitle>{t('editTitle', { name: customer.name })}</CardTitle>
          </CardHeader>
          <CardContent>
            <CustomerForm
              mode="edit"
              priceLists={priceListsData?.data ?? []}
              isSubmitting={updateMutation.isPending}
              submitError={submitError}
              defaultValues={{
                code: customer.code,
                name: customer.name,
                phone: customer.phone ?? '',
                contactPerson: customer.contactPerson ?? '',
                priceListId: customer.priceListId ?? '',
                paymentTermDays: customer.paymentTermDays,
              }}
              onSubmit={(input) => {
                setSubmitError(null);
                updateMutation.mutate(input, {
                  onSuccess: () => {
                    toast.success(t('updated'));
                    router.push(`/customers/${id}`);
                  },
                  onError: (err) => setSubmitError(errorMessage(err, locale)),
                });
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
