import type { SyncPriceItem, SyncProduct, SyncPackaging } from '@/lib/api/sync';

/** Mirrors apps/web/src/components/orders/order-line-editor.tsx's client-side preview and apps/api's sales.service.ts's authoritative computation (8.2) — used here for both the Order screen's running total and Home's offline "today's turnover" estimate from queued-but-unsynced orders. The server always recomputes the real total on submit; this is a preview only. */
export function computeLineTotal(params: {
  qty: number;
  packagingQtyInBaseUnit: number;
  price: number;
  discountPct: number;
  vatRate: number;
}): number {
  const baseQty = params.qty * params.packagingQtyInBaseUnit;
  return baseQty * params.price * (1 - params.discountPct / 100) * (1 + params.vatRate / 100);
}

/** 8.1: customer's own price list, falling back to the company default — matches SalesService.create()'s `customer.priceListId ?? defaultPriceListId()`. */
export function resolvePrice(
  productId: string,
  customerPriceListId: string | null,
  defaultPriceListId: string | null,
  prices: SyncPriceItem[],
): string | undefined {
  const listId = customerPriceListId ?? defaultPriceListId;
  if (!listId) return undefined;
  return prices.find((p) => p.productId === productId && p.priceListId === listId)?.price;
}

export interface EstimateOrderLine {
  productId: string;
  packagingId: string;
  qty: number;
  discountPct?: number;
}

/** Estimates an order's total from its lines alone (as queued offline, before the server confirms) — used by Home's offline "today's turnover" figure. Skips lines whose product/packaging/price can't be resolved locally rather than throwing, since a stale/incomplete local cache shouldn't crash the dashboard. */
export function estimateOrderTotal(
  lines: EstimateOrderLine[],
  customerPriceListId: string | null,
  defaultPriceListId: string | null,
  products: SyncProduct[],
  packagings: SyncPackaging[],
  prices: SyncPriceItem[],
): number {
  let total = 0;
  for (const line of lines) {
    const product = products.find((p) => p.id === line.productId);
    const packaging = packagings.find((p) => p.id === line.packagingId);
    const price = resolvePrice(line.productId, customerPriceListId, defaultPriceListId, prices);
    if (!product || !packaging || price === undefined) continue;
    total += computeLineTotal({
      qty: line.qty,
      packagingQtyInBaseUnit: Number(packaging.qtyInBaseUnit),
      price: Number(price),
      discountPct: line.discountPct ?? 0,
      vatRate: Number(product.vatRate),
    });
  }
  return total;
}
