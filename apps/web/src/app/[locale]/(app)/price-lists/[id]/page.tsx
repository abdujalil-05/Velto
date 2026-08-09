'use client';

import { use, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Search } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useProductsQuery } from '@/lib/api/products';
import { usePriceListItemsQuery, usePriceListsQuery, useUpsertPriceListItemsMutation } from '@/lib/api/price-lists';
import { errorMessage } from '@/lib/api/client';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';

export default function PriceListItemsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('PriceLists.itemsPage');
  const tList = useTranslations('PriceLists');
  const locale = useLocale();

  const priceLists = usePriceListsQuery();
  const priceList = priceLists.data?.data.find((pl) => pl.id === id);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);

  const products = useProductsQuery({ page, pageSize: 25, search: debouncedSearch || undefined });
  const items = usePriceListItemsQuery(id);
  const upsertMutation = useUpsertPriceListItemsMutation(id);

  // Capped at 100 existing items (same documented limit as the order-form's
  // price preview, lib/api/price-lists.ts) — a price list beyond 100 priced
  // SKUs won't show pre-existing prices for the rest, but editing/saving a
  // new price for any visible product row still works regardless.
  const priceByProductId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items.data?.data ?? []) map.set(item.productId, item.price);
    return map;
  }, [items.data]);

  const [edits, setEdits] = useState<Record<string, string>>({});
  const dirtyCount = Object.keys(edits).length;

  function valueFor(productId: string): string {
    return edits[productId] ?? priceByProductId.get(productId) ?? '';
  }

  function handleSave() {
    const upserts = Object.entries(edits)
      .map(([productId, price]) => ({ productId, price: Number(price) }))
      .filter((entry) => Number.isFinite(entry.price) && entry.price > 0);

    // Every edited row was blank/0/non-numeric: the button is enabled (there
    // *are* pending edits) so silently doing nothing looks like a broken save.
    if (upserts.length === 0) {
      toast.error(t('invalidPrice'));
      return;
    }

    upsertMutation.mutate(upserts, {
      onSuccess: () => {
        toast.success(t('saved'));
        setEdits({});
      },
      onError: (err) => toast.error(errorMessage(err, locale)),
    });
  }

  return (
    <div className="space-y-4">
      <Link href="/price-lists" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {tList('backToList')}
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{priceList?.name ?? t('title')}</h1>
        <Button onClick={handleSave} disabled={dirtyCount === 0 || upsertMutation.isPending}>
          {upsertMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('save')}
          {dirtyCount > 0 && ` (${dirtyCount})`}
        </Button>
      </div>

      {dirtyCount > 0 && (
        <Alert>
          <AlertDescription>{t('unsavedChanges')}</AlertDescription>
        </Alert>
      )}

      <div className="relative w-full max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder={t('searchProduct')}
          className="pl-9"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(products.isLoading || items.isLoading) && (
            <div className="space-y-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}

          {(products.isError || items.isError) && !products.isLoading && !items.isLoading && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-4">
                <span>{errorMessage(products.error ?? items.error, locale)}</span>
                <Button variant="outline" size="sm" onClick={() => (products.isError ? products.refetch() : items.refetch())}>
                  {tList('retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {products.data && !products.isLoading && !items.isLoading && (
            <>
              {products.data.data.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('noProducts')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="pb-2 pr-3 font-medium">{t('product')}</th>
                        <th className="pb-2 pr-3 font-medium">{t('sku')}</th>
                        <th className="pb-2 font-medium">{t('price')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {products.data.data.map((product) => (
                        <tr key={product.id}>
                          <td className="py-2 pr-3 font-medium">{product.name}</td>
                          <td className="py-2 pr-3 text-muted-foreground">{product.sku}</td>
                          <td className="py-2">
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              className="max-w-[10rem]"
                              value={valueFor(product.id)}
                              onChange={(e) => setEdits((prev) => ({ ...prev, [product.id]: e.target.value }))}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <PaginationBar meta={products.data.meta} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
