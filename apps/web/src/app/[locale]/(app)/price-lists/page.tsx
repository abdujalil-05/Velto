'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, RefreshCw, Tags } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { usePriceListsQuery } from '@/lib/api/price-lists';
import { errorMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PriceListsTable } from '@/components/price-lists/price-lists-table';
import { PriceListFormDialog } from '@/components/price-lists/price-list-form-dialog';
import { cn } from '@/lib/utils';

export default function PriceListsPage() {
  const t = useTranslations('PriceLists');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('catalog.create');

  const { data, isLoading, isError, error, refetch, isFetching } = usePriceListsQuery();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canCreate && (
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t('newPriceList')}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
          {t('refresh')}
        </Button>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 4 }).map((_, i) => (
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
            <Tags className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">{t('emptyState')}</p>
            {canCreate && (
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {t('newPriceList')}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <PriceListsTable priceLists={data.data} />
          </CardContent>
        </Card>
      )}

      <PriceListFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
