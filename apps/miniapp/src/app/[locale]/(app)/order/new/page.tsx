'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FreshnessLabel } from '@/components/freshness-label';
import { searchCustomers, searchProducts } from '@/lib/offline/search';
import { toast } from 'sonner';
import { History, Search } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import {
  useOfflineCategories,
  useOfflineCustomers,
  useOfflineDefaultPriceListId,
  useOfflineOutlets,
  useOfflinePackagings,
  useOfflinePrices,
  useOfflineProducts,
  useOfflineStock,
} from '@/lib/offline/use-offline-data';
import { checkQty, estimateOrderTotal, repeatLineQty, resolvePrice, withExpectedUnitPrices } from '@/lib/offline/pricing';
import type { SyncPackaging } from '@/lib/api/sync';
import { enqueueMany, QueueQuotaError, type EnqueueItem } from '@/lib/offline/queue';
import { ForeignLegacyBlockedError, VaultUnavailableError } from '@/lib/offline/vault';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { useLastOrderQuery, type CreateOrderInput } from '@/lib/api/orders';
import type { CreateVisitInput } from '@/lib/api/visits';
import { clearVisitGps, peekVisitGps } from '@/lib/gps-payload';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { formatMoney } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProductCard } from '@/components/orders/product-card';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';
import { cn } from '@/lib/utils';

interface CartLine {
  packagingId: string;
  qty: number;
}

export default function NewOrderPage() {
  const t = useTranslations('Order');
  const tCommon = useTranslations('Common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const syncEngine = useSyncEngine();

  const outletIdParam = searchParams.get('outletId');
  const visitStartedAt = searchParams.get('visitStartedAt');

  const outlets = useOfflineOutlets();
  const customers = useOfflineCustomers();
  const products = useOfflineProducts();
  const packagings = useOfflinePackagings();
  const prices = useOfflinePrices();
  const categories = useOfflineCategories();
  const stock = useOfflineStock();
  const defaultPriceListId = useOfflineDefaultPriceListId();

  const outlet = useMemo(
    () => (outletIdParam ? outlets.data?.find((o) => o.id === outletIdParam) : undefined),
    [outlets.data, outletIdParam],
  );
  const [manualCustomerId, setManualCustomerId] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const customerId = outlet?.customerId ?? manualCustomerId;
  const customer = useMemo(() => customers.data?.find((c) => c.id === customerId), [customers.data, customerId]);

  const lastOrder = useLastOrderQuery(customerId ?? null);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, CartLine>>({});
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // Stable per-document ids, created ONCE when the form opens: every retry/double-click reuses them (queue dedupes).
  const orderClientIdRef = useRef<string>('');
  const visitClientIdRef = useRef<string>('');
  if (!orderClientIdRef.current) orderClientIdRef.current = crypto.randomUUID();
  if (!visitClientIdRef.current) visitClientIdRef.current = crypto.randomUUID();
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [repeatConfirmOpen, setRepeatConfirmOpen] = useState(false);

  const lineCount = Object.keys(lines).length;

  // Leaving the screen throws the draft away — nothing on this page has been
  // enqueued yet, so there is nothing to recover from. Individual line
  // removals stay unconfirmed (pure form noise); losing the whole cart does
  // not. Registered after `lines` so the callback sees the current draft.
  useTelegramBackButton(
    useCallback(() => {
      if (lineCount > 0) {
        setDiscardConfirmOpen(true);
        return;
      }
      router.back();
    }, [lineCount, router]),
  );

  const packagingsByProduct = useMemo(() => {
    const map = new Map<string, SyncPackaging[]>();
    if (!packagings.data) return map;
    for (const pkg of packagings.data) {
      const list = map.get(pkg.productId) ?? [];
      list.push(pkg);
      map.set(pkg.productId, list);
    }
    return map;
  }, [packagings.data]);

  const availableByProduct = useMemo(() => {
    const map = new Map<string, number>();
    if (!stock.data) return map;
    for (const s of stock.data) {
      const avail = Number(s.onHand) - Number(s.reserved);
      map.set(s.productId, (map.get(s.productId) ?? 0) + avail);
    }
    return map;
  }, [stock.data]);

  const filteredProducts = useMemo(() => {
    if (!products.data) return [];
    return searchProducts(products.data, debouncedSearch, categoryId);
  }, [products.data, debouncedSearch, categoryId]);

  const filteredCustomers = useMemo(() => {
    if (outlet || !customers.data) return [];
    return searchCustomers(customers.data, customerQuery);
  }, [customers.data, customerQuery, outlet]);

  function defaultPackagingId(productId: string): string {
    const list = packagingsByProduct.get(productId) ?? [];
    return (list.find((p) => p.isDefault) ?? list[0])?.id ?? '';
  }

  // Stock is tracked in base units; the qty typed in the cart is in the
  // selected packaging's units — convert available down to match.
  function maxQtyFor(productId: string, packagingId: string): number {
    const availableBase = availableByProduct.get(productId) ?? 0;
    const packaging = (packagingsByProduct.get(productId) ?? []).find((p) => p.id === packagingId);
    const qtyInBaseUnit = packaging ? Number(packaging.qtyInBaseUnit) : 1;
    return qtyInBaseUnit > 0 ? availableBase / qtyInBaseUnit : availableBase;
  }

  function updateQty(productId: string, qty: number) {
    setLines((prev) => {
      if (qty <= 0) {
        const next = { ...prev };
        delete next[productId];
        return next;
      }
      const packagingId = prev[productId]?.packagingId || defaultPackagingId(productId);
      return { ...prev, [productId]: { packagingId, qty } };
    });
  }

  function updatePackaging(productId: string, packagingId: string) {
    setLines((prev) => ({ ...prev, [productId]: { qty: prev[productId]?.qty ?? 0, packagingId } }));
  }

  const cartLineInputs = useMemo(
    () => Object.entries(lines).filter(([, l]) => l.qty > 0).map(([productId, l]) => ({ productId, packagingId: l.packagingId, qty: l.qty })),
    [lines],
  );

  const hasStockIssues = useMemo(
    () => cartLineInputs.some((l) => l.qty > maxQtyFor(l.productId, l.packagingId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- maxQtyFor closes over availableByProduct/packagingsByProduct, both already memoized on stock.data/packagings.data
    [cartLineInputs, availableByProduct, packagingsByProduct],
  );

  // ADR-059 UX mirror of the server rule: qty ≤3dp and qty × factor ≤3dp. Blocks save, never rounds.
  const qtyIssue = useMemo(() => {
    for (const l of cartLineInputs) {
      const pkg = (packagingsByProduct.get(l.productId) ?? []).find((p) => p.id === l.packagingId);
      const r = checkQty(l.qty, pkg?.qtyInBaseUnit ?? '1');
      if (r !== 'ok') return r;
    }
    return null;
  }, [cartLineInputs, packagingsByProduct]);

  const cartTotal = useMemo(() => {
    if (!products.data || !packagings.data || !prices.data || defaultPriceListId.data === undefined) return 0;
    return estimateOrderTotal(cartLineInputs, customer?.priceListId ?? null, defaultPriceListId.data, products.data, packagings.data, prices.data);
  }, [cartLineInputs, products.data, packagings.data, prices.data, defaultPriceListId.data, customer]);

  function repeatLastOrder() {
    if (!lastOrder.data || !packagings.data) return;
    const next: Record<string, CartLine> = {};
    let manual = 0;
    for (const line of lastOrder.data.lines) {
      // line.qty is in base units; exact BigInt division, else base packaging, else manual (never float/rounded).
      const res = repeatLineQty(line.qty, line.packagingId, packagingsByProduct.get(line.productId) ?? []);
      if (!res) {
        manual += 1;
        continue;
      }
      next[line.productId] = { packagingId: res.packagingId, qty: Number(res.qty) };
    }
    setLines(next);
    setRepeatConfirmOpen(false);
    if (manual > 0) toast.warning(t('repeatedPartial', { count: manual }));
    else toast.success(t('repeated'));
  }

  function saveErrorMessage(err: unknown): string {
    // Nothing was written in any of these cases; the cart stays in memory with the same clientIds.
    if (err instanceof VaultUnavailableError) return t('vaultBlocked');
    if (err instanceof ForeignLegacyBlockedError) return t('foreignLegacyBlocked');
    return err instanceof QueueQuotaError ? t('saveQuotaFull') : t('saveFailed');
  }

  async function handleSave() {
    if (!customerId || cartLineInputs.length === 0 || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    let written = false;
    try {
      const orderPayload: CreateOrderInput = {
        customerId,
        outletId: outlet?.id,
        clientId: orderClientIdRef.current,
        lines: withExpectedUnitPrices(cartLineInputs, customer?.priceListId ?? null, defaultPriceListId.data ?? null, prices.data ?? []),
      };
      const items: EnqueueItem[] = [{ type: 'order', payload: orderPayload as unknown as Record<string, unknown>, clientId: orderClientIdRef.current }];
      let visitQueued = false;
      if (outlet && visitStartedAt) {
        visitQueued = true;
        const visitPayload: CreateVisitInput = {
          outletId: outlet.id,
          startedAt: visitStartedAt,
          endedAt: new Date().toISOString(),
          ...peekVisitGps(outlet.id),
          outcome: 'ORDERED',
          clientId: visitClientIdRef.current,
        };
        items.push({ type: 'visit', payload: visitPayload as unknown as Record<string, unknown>, clientId: visitClientIdRef.current });
      }
      // One atomic device write: order + visit both land or neither does. Success here means "saved on this device" only.
      await enqueueMany(items);
      written = true;
      // The document is durably queued: the next document on this instance gets fresh ids and an empty cart.
      orderClientIdRef.current = crypto.randomUUID();
      visitClientIdRef.current = crypto.randomUUID();
      setLines({});
      if (outlet && visitQueued) clearVisitGps(outlet.id);
      syncEngine.notifyQueueChanged();
      toast.success(t('saved'));
      router.push('/route');
    } catch (err) {
      // A queue-write error is a failure (cart stays, same clientIds). Anything after a successful write is not.
      if (!written) toast.error(saveErrorMessage(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const isLoading = products.isLoading || packagings.isLoading || prices.isLoading || categories.isLoading || stock.isLoading || outlets.isLoading;
  const isError = products.isError || packagings.isError || prices.isError || categories.isError || stock.isError;

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('loadError')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      {!customerId ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('pickCustomer')}</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} placeholder={t('searchCustomer')} className="pl-9" />
          </div>
          {filteredCustomers.length > 0 && (
            <div className="divide-y divide-border rounded-md border border-border">
              {filteredCustomers.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setManualCustomerId(c.id)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.code}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('customer')}</p>
              <p className="font-medium">{customer?.name}</p>
            </div>
            {lastOrder.data && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => (lineCount > 0 ? setRepeatConfirmOpen(true) : repeatLastOrder())}
                className="gap-1.5"
              >
                <History className="h-3.5 w-3.5" />
                {t('repeatLastOrder')}
              </Button>
            )}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchProduct')} className="pl-9" />
          </div>

          {categories.data && categories.data.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setCategoryId(null)}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1.5 text-xs',
                  categoryId === null ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground',
                )}
              >
                {tCommon('all')}
              </button>
              {categories.data.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategoryId(cat.id)}
                  className={cn(
                    'shrink-0 rounded-full border px-3 py-1.5 text-xs',
                    categoryId === cat.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground',
                  )}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          )}

          <FreshnessLabel dataset="stock" />
          <FreshnessLabel dataset="prices" />

          {filteredProducts.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">{t('noProducts')}</CardContent>
            </Card>
          )}

          <div className="space-y-2">
            {filteredProducts.map((product) => {
              const productPackagings = packagingsByProduct.get(product.id) ?? [];
              const line = lines[product.id];
              const packagingId = line?.packagingId || defaultPackagingId(product.id);
              const price = resolvePrice(product.id, customer?.priceListId ?? null, defaultPriceListId.data ?? null, prices.data ?? []);
              return (
                <ProductCard
                  key={product.id}
                  product={product}
                  packagings={productPackagings}
                  price={price}
                  availableQty={availableByProduct.get(product.id) ?? 0}
                  maxQty={maxQtyFor(product.id, packagingId)}
                  packagingId={packagingId}
                  qty={line?.qty ?? 0}
                  onPackagingChange={(pid) => updatePackaging(product.id, pid)}
                  onQtyChange={(qty) => updateQty(product.id, qty)}
                />
              );
            })}
          </div>

          <div className="fixed inset-x-0 bottom-0 mx-auto max-w-lg border-t border-border bg-background p-4">
            {qtyIssue && (
              <Alert variant="destructive" className="mb-2">
                <AlertDescription>{qtyIssue === 'qtyScale' ? t('qtyScaleError') : t('qtyBaseScaleError')}</AlertDescription>
              </Alert>
            )}
            {hasStockIssues && (
              <Alert variant="destructive" className="mb-2">
                <AlertDescription>{t('stockExceededBanner')}</AlertDescription>
              </Alert>
            )}
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('total')}</span>
              <span className="text-lg font-bold tabular-nums">
                {formatMoney(cartTotal)} {tCommon('somUnit')}
              </span>
            </div>
            <Button size="lg" className="w-full" disabled={cartLineInputs.length === 0 || hasStockIssues || qtyIssue !== null || submitting} onClick={handleSave}>
              {t('save')}
            </Button>
          </div>
        </>
      )}

      <ConfirmSheet
        open={repeatConfirmOpen}
        onOpenChange={setRepeatConfirmOpen}
        title={t('repeatConfirmTitle')}
        description={t('repeatConfirmDescription', { count: lineCount })}
        itemName={customer?.name}
        confirmLabel={t('repeatConfirmAction')}
        onConfirm={repeatLastOrder}
      />

      <ConfirmSheet
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        title={t('discardConfirmTitle')}
        description={t('discardConfirmDescription', { count: lineCount })}
        itemName={customer?.name}
        confirmLabel={t('discardConfirmAction')}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          router.back();
        }}
      />
    </div>
  );
}
