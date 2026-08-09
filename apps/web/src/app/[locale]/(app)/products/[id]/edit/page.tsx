'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useDeleteProductMutation, useProductQuery, useUpdateProductMutation } from '@/lib/api/products';
import { useCategoriesQuery } from '@/lib/api/categories';
import { errorMessage } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ProductForm } from '@/components/products/product-form';
import { ProductImageUpload } from '@/components/products/product-image-upload';

export default function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Products.form');
  const locale = useLocale();
  const router = useRouter();

  const { data: product, isLoading, isError, error, refetch } = useProductQuery(id);
  const { data: categories } = useCategoriesQuery();
  const updateMutation = useUpdateProductMutation(id);
  const deleteMutation = useDeleteProductMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Link href="/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
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

      {product && (
        <Card className="mx-auto max-w-2xl">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>{t('editTitle', { name: product.name })}</CardTitle>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('delete')}
            </Button>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label>{t('image')}</Label>
              <ProductImageUpload productId={id} imageUrl={product.imageUrl} />
            </div>

            <ProductForm
              mode="edit"
              categories={categories ?? []}
              isSubmitting={updateMutation.isPending}
              submitError={submitError}
              defaultValues={{
                sku: product.sku,
                name: product.name,
                brand: product.brand ?? '',
                baseUnit: product.baseUnit,
                categoryId: product.categoryId ?? '',
                price: product.price ? Number(product.price) : undefined,
                packagings: product.packagings.map((p) => ({
                  name: p.name,
                  qtyInBaseUnit: Number(p.qtyInBaseUnit),
                  isDefault: p.isDefault,
                })),
              }}
              onSubmit={(input) => {
                setSubmitError(null);
                updateMutation.mutate(input, {
                  onSuccess: () => {
                    toast.success(t('updated'));
                    router.push('/products');
                  },
                  onError: (err) => setSubmitError(errorMessage(err, locale)),
                });
              }}
            />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        itemName={product?.name ?? ''}
        error={deleteError}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          setDeleteError(null);
          deleteMutation.mutate(id, {
            onSuccess: () => {
              toast.success(t('deleted'));
              router.push('/products');
            },
            onError: (err) => setDeleteError(errorMessage(err, locale)),
          });
        }}
      />
    </div>
  );
}
