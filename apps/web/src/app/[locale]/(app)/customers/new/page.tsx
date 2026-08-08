'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useCreateCustomerMutation, type DuplicateWarning } from '@/lib/api/customers';
import { usePriceListsQuery } from '@/lib/api/price-lists';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CustomerForm } from '@/components/customers/customer-form';

export default function NewCustomerPage() {
  const t = useTranslations('Customers.form');
  const locale = useLocale();
  const router = useRouter();
  const { data: priceListsData } = usePriceListsQuery();
  const createMutation = useCreateCustomerMutation();

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<DuplicateWarning[] | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle>{t('createTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerForm
            mode="create"
            priceLists={priceListsData?.data ?? []}
            isSubmitting={createMutation.isPending}
            submitError={submitError}
            onSubmit={(input) => {
              setSubmitError(null);
              createMutation.mutate(input, {
                onSuccess: (result) => {
                  if (result.warnings.length > 0) {
                    setWarnings(result.warnings);
                    setCreatedId(result.customer.id);
                  } else {
                    toast.success(t('created'));
                    router.push(`/customers/${result.customer.id}`);
                  }
                },
                onError: (error) => setSubmitError(errorMessage(error, locale)),
              });
            }}
          />
        </CardContent>
      </Card>

      <Dialog open={warnings !== null} onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-warning" />
              {t('duplicateWarningsTitle')}
            </DialogTitle>
          </DialogHeader>
          <ul className="space-y-2 text-sm">
            {warnings?.map((w, i) => (
              <li key={i} className="rounded-md bg-muted p-2">
                <span className="font-medium">{w.customerName}</span> — {t(`duplicateType.${w.type}`)} ({w.detail})
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              onClick={() => {
                if (createdId) router.push(`/customers/${createdId}`);
              }}
            >
              {t('duplicateWarningsAck')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
