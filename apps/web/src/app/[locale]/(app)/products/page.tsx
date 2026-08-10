'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Package, Plus, RefreshCw, Search } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useDeleteProductMutation, useProductsQuery, type Product } from '@/lib/api/products';
import { useCategoriesQuery } from '@/lib/api/categories';
import { errorMessage } from '@/lib/api/client';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useSort } from '@/lib/hooks/use-sort';
import { exportToCsv } from '@/lib/export-csv';
import { formatMoney } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ExportCsvButton } from '@/components/shared/export-csv-button';
import { ProductsTable } from '@/components/products/products-table';
import { cn } from '@/lib/utils';

export default function ProductsPage() {
  const t = useTranslations('Products');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canDelete = hasPermission('catalog.delete');

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const { sort, toggle: toggleSort } = useSort();

  const { data: categories } = useCategoriesQuery();
  const { data, isLoading, isError, error, refetch, isFetching } = useProductsQuery({
    page,
    pageSize: 25,
    search: debouncedSearch || undefined,
    categoryId: categoryId || undefined,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
  });

  const deleteMutation = useDeleteProductMutation();
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(pendingDelete.id);
      toast.success(t('deleteSuccess', { name: pendingDelete.name }));
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(errorMessage(err, locale));
    }
  }

  const hasFilters = debouncedSearch.length > 0 || !!categoryId;

  function handleExport() {
    if (!data) return;
    exportToCsv(`mahsulotlar-${new Date().toISOString().slice(0, 10)}.csv`, data.data, [
      { header: t('sku'), value: (p) => p.sku },
      { header: t('name'), value: (p) => p.name },
      { header: t('brand'), value: (p) => p.brand ?? '' },
      { header: t('category'), value: (p) => p.category?.name ?? '' },
      { header: t('price'), value: (p) => (p.price ? formatMoney(p.price) : '') },
      { header: t('status'), value: (p) => (p.isActive ? t('active') : t('inactive')) },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {hasPermission('catalog.create') && (
          <Link href="/products/new" className={buttonVariants({})}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newProduct')}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('searchPlaceholder')}
            className="pl-9"
          />
        </div>

        <div className="w-full max-w-xs">
          <Select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('allCategories')}</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>

        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
          {t('refresh')}
        </Button>

        <ExportCsvButton onExport={handleExport} disabled={!data || data.data.length === 0} />
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      )}

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

      {data && data.data.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Package className="h-10 w-10 text-muted-foreground" />
            {hasFilters ? (
              <p className="text-sm text-muted-foreground">{t('emptySearch')}</p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
                {hasPermission('catalog.create') && (
                  <Link href="/products/new" className={buttonVariants({ size: 'sm' })}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('newProduct')}
                  </Link>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <ProductsTable
              products={data.data}
              sort={sort}
              onSort={toggleSort}
              canDelete={canDelete}
              onDelete={(product) => {
                setDeleteError(null);
                setPendingDelete(product);
              }}
            />
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title={t('confirmDelete.title')}
        description={t('confirmDelete.description', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('delete')}
        error={deleteError}
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
