import { useQuery } from '@tanstack/react-query';
import { offlineRepository, getDefaultPriceListId } from './repository';
import { queueRepository } from './queue';

// Local-first reads: these hit Dexie only, never the network — the sync
// engine (sync-engine.tsx) is solely responsible for keeping Dexie current
// and invalidates the `['offline', ...]` query key after every successful
// pull, so screens re-render with fresh data without themselves knowing or
// caring whether that data arrived while online or was already on-device.

export function useOfflineProducts() {
  return useQuery({ queryKey: ['offline', 'products'], queryFn: () => offlineRepository.products.toArray(), staleTime: Infinity });
}

export function useOfflinePackagings() {
  return useQuery({ queryKey: ['offline', 'packagings'], queryFn: () => offlineRepository.packagings.toArray(), staleTime: Infinity });
}

export function useOfflinePrices() {
  return useQuery({ queryKey: ['offline', 'prices'], queryFn: () => offlineRepository.prices.toArray(), staleTime: Infinity });
}

export function useOfflineCustomers() {
  return useQuery({ queryKey: ['offline', 'customers'], queryFn: () => offlineRepository.customers.toArray(), staleTime: Infinity });
}

export function useOfflineOutlets() {
  return useQuery({ queryKey: ['offline', 'outlets'], queryFn: () => offlineRepository.outlets.toArray(), staleTime: Infinity });
}

export function useOfflineStock() {
  return useQuery({ queryKey: ['offline', 'stock'], queryFn: () => offlineRepository.stock.toArray(), staleTime: Infinity });
}

export function useOfflineCategories() {
  return useQuery({ queryKey: ['offline', 'categories'], queryFn: () => offlineRepository.categories.toArray(), staleTime: Infinity });
}

export function useOfflineBalances() {
  return useQuery({ queryKey: ['offline', 'balances'], queryFn: () => offlineRepository.balances.toArray(), staleTime: Infinity });
}

export function useOfflineRoutes() {
  return useQuery({ queryKey: ['offline', 'routes'], queryFn: () => offlineRepository.routes.toArray(), staleTime: Infinity });
}

export function useOfflineRouteStops() {
  return useQuery({ queryKey: ['offline', 'routeStops'], queryFn: () => offlineRepository.routeStops.toArray(), staleTime: Infinity });
}

export function useOfflineDefaultPriceListId() {
  return useQuery({ queryKey: ['offline', 'defaultPriceListId'], queryFn: getDefaultPriceListId, staleTime: Infinity });
}

/** Today's queued (pending or already synced) documents of one type — the offline-first source for "8/22 nuqta"-style today counters (Home §9.4 Ekran 1) and Route's per-stop visited badge. */
export function useOfflineTodayQueue(type: 'order' | 'visit' | 'payment') {
  return useQuery({ queryKey: ['offline', 'queue', 'today', type], queryFn: () => queueRepository.todayByType(type), staleTime: 5_000 });
}
