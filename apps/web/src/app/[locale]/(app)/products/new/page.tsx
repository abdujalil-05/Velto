'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useCreateProductMutation } from '@/lib/api/products';
import { useCategoriesQuery } from '@/lib/api/categories';
import { useReceiveStockMutation } from '@/lib/api/stock';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProductForm } from '@/components/products/product-form';

export default function NewProductPage() {
  const t = useTranslations('Products.form');
  const locale = useLocale();
  const router = useRouter();
  const { data: categories } = useCategoriesQuery();
  const createMutation = useCreateProductMutation();
  const receiveMutation = useReceiveStockMutation();

  const [submitError, setSubmitError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Link href="/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle>{t('createTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm
            mode="create"
            categories={categories ?? []}
            isSubmitting={createMutation.isPending || receiveMutation.isPending}
            submitError={submitError}
            onSubmit={(input, stockInit) => {
              setSubmitError(null);
              createMutation.mutate(input, {
                onSuccess: (product) => {
                  if (!stockInit) {
                    toast.success(t('created'));
                    router.push(`/products/${product.id}/edit`);
                    return;
                  }
                  receiveMutation.mutate(
                    { productId: product.id, warehouseId: stockInit.warehouseId, qty: stockInit.qty },
                    {
                      onSuccess: () => {
                        toast.success(t('created'));
                        router.push(`/products/${product.id}/edit`);
                      },
                      onError: (error) => {
                        // The product itself was created successfully — only the
                        // initial stock receive failed, so send the user to the
                        // product (where they can retry via Stock > Receive)
                        // instead of blocking on the create form.
                        toast.success(t('created'));
                        toast.error(errorMessage(error, locale));
                        router.push(`/products/${product.id}/edit`);
                      },
                    },
                  );
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
