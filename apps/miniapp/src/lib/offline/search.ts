import type { SyncCustomer, SyncProduct } from '@/lib/api/sync';

/** Local product search (NFR-PERF-004): name / sku / barcode substring, active only, optional category. */
export function searchProducts(products: SyncProduct[], query: string, categoryId?: string | null): SyncProduct[] {
  const q = query.trim().toLowerCase();
  return products
    .filter((p) => p.isActive)
    .filter((p) => !categoryId || p.categoryId === categoryId)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Local customer search: name / code substring, not blocked; empty query returns nothing. */
export function searchCustomers(customers: SyncCustomer[], query: string, limit = 15): SyncCustomer[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return customers.filter((c) => !c.isBlocked && (c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))).slice(0, limit);
}
