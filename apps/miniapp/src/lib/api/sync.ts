import type { GpsStatus } from '@/lib/gps-payload';
import type { TokenOwner } from '@/lib/auth/tokens';
import { apiFetch } from './client';
import type { PaymentStatus } from './payments';
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

export type SyncTombstoneEntity =
  | 'Product'
  | 'ProductPackaging'
  | 'PriceListItem'
  | 'Customer'
  | 'Outlet'
  | 'StockLevel'
  | 'ProductCategory';

/** entityKey: PriceListItem {priceListId,productId}; StockLevel {productId,warehouseId} (entityId "p:w"); otherwise null. */
export interface SyncTombstone {
  entity: SyncTombstoneEntity;
  entityId: string;
  entityKey: Record<string, string> | null;
  deletedAt: string;
  changeSeq: string;
}

/** SALES_AGENT only (null for other roles): the full set of customers/outlets this agent may hold locally. */
export interface SyncScope {
  customerIds: string[];
  outletIds: string[];
}

/** Mirrors apps/api sync.service.ts pull() (F4: changeSeq cursor, tombstones, scope). Rows may carry an optional `changeSeq` string. */
export interface SyncPullResult {
  /** Opaque — store exactly as returned (may be lower than a previously seen seq; the server resends a window, so upserts are idempotent). */
  cursor: string;
  hasMore: boolean;
  fullResync: boolean;
  products: SyncProduct[];
  packagings: SyncPackaging[];
  prices: SyncPriceItem[];
  customers: SyncCustomer[];
  outlets: SyncOutlet[];
  stock: SyncStock[];
  categories: SyncCategory[];
  balances: SyncBalance[];
  tombstones: SyncTombstone[];
  routes: SyncRoute[];
  routeStops: SyncRouteStop[];
  defaultPriceListId: string | null;
  scope: SyncScope | null;
}

/** Imperative (non-hook) pull. No cursor (or an invalid one) = full snapshot. */
export function pullSync(cursor?: string, limit?: number, owner?: TokenOwner): Promise<SyncPullResult> {
  return apiFetch<SyncPullResult>(`/sync/pull${toQueryString({ cursor, limit })}`, { owner });
}

// Mirrors apps/api/src/modules/sync/dto/sync-push.dto.ts's SyncDocType and
// apps/api/src/modules/sync/sync.service.ts's SyncPushResultItem exactly.

export type SyncDocType = 'order' | 'visit' | 'payment';

export interface SyncPushDocument {
  type: SyncDocType;
  clientId: string;
  payload: Record<string, unknown>;
}

export type SyncDocStatus = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'CONFLICT' | 'RETRY';

export interface SyncPushResultItem {
  clientId: string;
  status: SyncDocStatus;
  id?: string;
  /** Visit entries only: server-computed GPS verdict. */
  gpsStatus?: GpsStatus;
  distanceM?: string | null;
  /** Payment entries only (ADR-029): agent cash is PENDING_HANDOVER until the cashier accepts. */
  paymentStatus?: PaymentStatus;
  error?: { code: string; message: string; messages?: { uz: string; ru: string; en: string }; details?: unknown };
}

/** 10.3: up to 20 queued documents per push — the queue engine (offline/sync-engine.tsx) enforces the batch-size cap before calling this. */
export function pushSync(documents: SyncPushDocument[], signal?: AbortSignal, owner?: TokenOwner): Promise<{ results: SyncPushResultItem[] }> {
  return apiFetch<{ results: SyncPushResultItem[] }>('/sync/push', { method: 'POST', body: { documents }, signal, owner });
}
