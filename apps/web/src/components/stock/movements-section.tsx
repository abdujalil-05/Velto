'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { History, RefreshCw, Undo2 } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import { useReverseStockMovementMutation, useStockMovementsQuery, type StockMovementRow, type StockMovementType } from '@/lib/api/stock';
import { useWarehousesQuery } from '@/lib/api/warehouses';
import { useProductsQuery } from '@/lib/api/products';
import { formatDateTime, formatQty } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ReverseDialog } from '@/components/shared/reverse-dialog';
import { cn } from '@/lib/utils';

const TYPES: StockMovementType[] = ['RECEIVE', 'ISSUE', 'RESERVE', 'RELEASE', 'ADJUST'];

export function MovementsSection() {
  const t = useTranslations('Stock.movements');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canReverse = hasPermission('stock.reverse');

  const [page, setPage] = useState(1);
  const [productId, setProductId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [type, setType] = useState<StockMovementType | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [target, setTarget] = useState<StockMovementRow | null>(null);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const reverseKey = useRef<string | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useStockMovementsQuery({
    page,
    pageSize: 25,
    productId: productId || undefined,
    warehouseId: warehouseId || undefined,
    type: type || undefined,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  });
  const warehouses = useWarehousesQuery();
  const products = useProductsQuery({ pageSize: 100 });
  const reverseMutation = useReverseStockMovementMutation();

  const warehouseName = (id: string) => warehouses.data?.find((w) => w.id === id)?.name ?? id.slice(0, 8);
  const productName = (id: string) => products.data?.data.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const setFilter = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1">
          <Label htmlFor="mvProduct">{t('product')}</Label>
          <Select id="mvProduct" value={productId} onChange={(e) => setFilter(setProductId)(e.target.value)}>
            <option value="">{t('all')}</option>
            {products.data?.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mvWarehouse">{t('warehouse')}</Label>
          <Select id="mvWarehouse" value={warehouseId} onChange={(e) => setFilter(setWarehouseId)(e.target.value)}>
            <option value="">{t('all')}</option>
            {warehouses.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mvType">{t('type')}</Label>
          <Select id="mvType" value={type} onChange={(e) => setFilter(setType)(e.target.value as StockMovementType | '')}>
            <option value="">{t('all')}</option>
            {TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`types.${x}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mvFrom">{t('from')}</Label>
          <Input id="mvFrom" type="date" value={from} onChange={(e) => setFilter(setFrom)(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mvTo">{t('to')}</Label>
          <Input id="mvTo" type="date" value={to} onChange={(e) => setFilter(setTo)(e.target.value)} />
        </div>
      </div>

      <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
        <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
        {t('refresh')}
      </Button>

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
            <History className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('date')}</th>
                    <th className="py-2 pr-3 font-medium">{t('type')}</th>
                    <th className="py-2 pr-3 font-medium">{t('product')}</th>
                    <th className="py-2 pr-3 font-medium">{t('warehouse')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('qty')}</th>
                    <th className="py-2 pr-3 font-medium">{t('reason')}</th>
                    <th className="py-2 font-medium">{t('status')}</th>
                    {canReverse && <th className="py-2 text-right font-medium">{t('actions')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(m.createdAt, locale)}</td>
                      <td className="py-2 pr-3">{t(`types.${m.type}`)}</td>
                      <td className="py-2 pr-3">{productName(m.productId)}</td>
                      <td className="py-2 pr-3">{warehouseName(m.warehouseId)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatQty(m.qty)}</td>
                      <td className="py-2 pr-3">{m.reason ?? '—'}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {m.reversesMovementId && <Badge variant="outline">{t('isReversal')}</Badge>}
                          {m.reversedBy && <Badge variant="secondary">{t('reversed')}</Badge>}
                        </div>
                      </td>
                      {canReverse && (
                        <td className="py-2 text-right">
                          {m.reversible && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                reverseKey.current = null;
                                setReverseError(null);
                                setTarget(m);
                              }}
                            >
                              <Undo2 className="mr-2 h-4 w-4" />
                              {t('reverse.action')}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar meta={data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      {target && (
        <ReverseDialog
          key={target.id}
          open
          onOpenChange={(open) => !open && setTarget(null)}
          title={t('reverse.title')}
          description={t('reverse.description')}
          error={reverseError}
          isPending={reverseMutation.isPending}
          onConfirm={(reason) => {
            setReverseError(null);
            reverseMutation.mutate(
              { id: target.id, reason, idempotencyKey: (reverseKey.current ??= crypto.randomUUID()) },
              {
                onSuccess: () => {
                  reverseKey.current = null;
                  setTarget(null);
                  toast.success(t('reverse.success'));
                },
                onError: (err) => setReverseError(errorMessage(err, locale)),
              },
            );
          }}
        />
      )}
    </div>
  );
}
