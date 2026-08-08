import { apiFetch } from './client';
import { toQueryString } from './query-string';

// Mirrors apps/api/src/modules/sync/sync.service.ts's pull() response
// (10.1/10.2) — the offline sync engine's reference-data source
// (src/lib/offline/sync-engine.tsx), persisted into Dexie rather than held
// in the react-query cache, since it must survive reload/offline.

export interface SyncProduct {
  id: string;
  categoryId: string | null;
  sku: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  baseUnit: string;
  vatRate: string;
  minPrice: string | null;
  imageUrl: string | null;
  isActive: boolean;
}

export interface SyncPackaging {
  id: string;
  productId: string;
  name: string;
  qtyInBaseUnit: string;
  isDefault: boolean;
}

export interface SyncPriceItem {
  id: string;
  priceListId: string;
  productId: string;
  price: string;
}

export interface SyncCustomer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  priceListId: string | null;
  paymentTermDays: number;
  isBlocked: boolean;
  cachedBalance: string;
  isActive: boolean;
}

export interface SyncOutlet {
  id: string;
  customerId: string;
  name: string;
  type: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  isActive: boolean;
}

export interface SyncStock {
  productId: string;
  warehouseId: string;
  onHand: string;
  reserved: string;
}

export interface SyncCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export interface SyncRoute {
  id: string;
  agentId: string;
  weekday: number;
  name: string;
}

export interface SyncRouteStop {
  id: string;
  routeId: string;
  outletId: string;
  sortOrder: number;
}

export interface SyncBalance {
  customerId: string;
  balance: string;
  updatedAt: string;
}

export interface SyncPullResult {
  cursor: string;
  products: SyncProduct[];
  packagings: SyncPackaging[];
  prices: SyncPriceItem[];
  customers: SyncCustomer[];
  outlets: SyncOutlet[];
  stock: SyncStock[];
  categories: SyncCategory[];
  balances: SyncBalance[];
  routes: SyncRoute[];
  routeStops: SyncRouteStop[];
  defaultPriceListId: string | null;
}

/** Imperative (non-hook) pull for the offline sync engine, which drives fetches on its own interval/reconnect schedule rather than a component's render. */
export function pullSync(since?: string): Promise<SyncPullResult> {
  return apiFetch<SyncPullResult>(`/sync/pull${toQueryString({ since })}`);
}

// Mirrors apps/api/src/modules/sync/dto/sync-push.dto.ts's SyncDocType and
// apps/api/src/modules/sync/sync.service.ts's SyncPushResultItem exactly.

export type SyncDocType = 'order' | 'visit' | 'payment';

export interface SyncPushDocument {
  type: SyncDocType;
  clientId: string;
  payload: Record<string, unknown>;
}

export type SyncDocStatus = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';

export interface SyncPushResultItem {
  clientId: string;
  status: SyncDocStatus;
  id?: string;
  error?: { code: string; message: string };
}

/** 10.3: up to 20 queued documents per push — the queue engine (offline/sync-engine.tsx) enforces the batch-size cap before calling this. */
export function pushSync(documents: SyncPushDocument[]): Promise<{ results: SyncPushResultItem[] }> {
  return apiFetch<{ results: SyncPushResultItem[] }>('/sync/push', { method: 'POST', body: { documents } });
}
