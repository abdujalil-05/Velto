import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type OrderStatus = 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CLOSED' | 'CANCELLED';

export interface OrderLine {
  id: string;
  productId: string;
  packagingId: string;
  qty: string;
  unitPrice: string;
  discountPct: string;
  lineTotal: string;
  product: { id: string; name: string; sku: string };
  packaging: { id: string; name: string; qtyInBaseUnit: string };
}

/** The delivery staff member the order is assigned to — an ordinary User carrying the COURIER role. */
export interface OrderCourier {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface Order {
  id: string;
  number: string;
  customerId: string;
  outletId: string | null;
  agentId: string | null;
  courierId: string | null;
  status: OrderStatus;
  createdAt: string;
  lines: OrderLine[];
  total: string;
  courier?: OrderCourier | null;
  // Relations the courier screen renders. Optional because the agent-facing
  // callers of /orders don't need them (they read customer/outlet from the
  // encrypted offline store instead) — a courier's device has no synced
  // customer data at all, so for them these must come from the API.
  // `Outlet` has no phone column — Customer.phone is the number to call.
  customer?: { id: string; name: string; code: string; phone: string | null } | null;
  outlet?: { id: string; name: string; address: string | null } | null;
}

export interface ListOrdersParams {
  page?: number;
  pageSize?: number;
  customerId?: string;
  agentId?: string;
  courierId?: string;
  status?: OrderStatus;
  from?: string;
  to?: string;
  [key: string]: string | number | undefined;
}

export function useOrdersQuery(params: ListOrdersParams, enabled = true) {
  return useQuery({
    queryKey: ['orders', params],
    queryFn: () => apiFetch<PaginatedResult<Order>>(`/orders${toQueryString(params)}`),
    enabled,
  });
}

/** 9.4 Ekran 1/4: the customer's most recent order, source for the "repeat last order" shortcut. */
export function useLastOrderQuery(customerId: string | null) {
  return useQuery({
    queryKey: ['orders', 'last', customerId],
    queryFn: () => apiFetch<PaginatedResult<Order>>(`/orders${toQueryString({ customerId: customerId!, pageSize: 1 })}`),
    enabled: !!customerId,
    select: (result) => result.data[0] ?? null,
  });
}

/**
 * Orders assigned to the signed-in courier. Deliberately online-only: unlike the
 * agent screens this does not go through the offline store or the mutation queue
 * (owner's scope decision — a courier is at the warehouse/on the road with a
 * phone that has never run a /sync/pull for this data).
 */
export function useCourierOrdersQuery(courierId: string | null | undefined) {
  return useQuery({
    queryKey: ['orders', 'courier', courierId],
    queryFn: () => apiFetch<PaginatedResult<Order>>(`/orders${toQueryString({ courierId: courierId!, pageSize: 100 })}`),
    enabled: !!courierId,
  });
}

/** POST /orders/:id/deliver — requires `orders.update`, which the COURIER role holds. */
export function useDeliverOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => apiFetch<Order>(`/orders/${orderId}/deliver`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export interface CreateOrderLineInput {
  productId: string;
  packagingId: string;
  qty: number;
  discountPct?: number;
}

export interface CreateOrderInput {
  customerId: string;
  outletId?: string;
  note?: string;
  clientId: string;
  lines: CreateOrderLineInput[];
}

export function useCreateOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrderInput) => apiFetch<Order>('/orders', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
}
