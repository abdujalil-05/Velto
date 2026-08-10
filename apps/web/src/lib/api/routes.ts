import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export interface RouteStop {
  id: string;
  routeId: string;
  outletId: string;
  sortOrder: number;
  outlet: { id: string; name: string; address: string | null; latitude: string | null; longitude: string | null; customerId: string };
}

export interface Route {
  id: string;
  companyId: string;
  /** Exactly one of `agentId` / `supplierId` is set — a route is served either by an own field agent or a deliverer supplier. */
  agentId: string | null;
  supplierId: string | null;
  weekday: number; // 1 (Mon) – 7 (Sun), ISO
  name: string;
  createdAt: string;
  updatedAt: string;
  agent: { id: string; firstName: string; lastName: string } | null;
  deliverySupplier: { id: string; name: string } | null;
  stops: RouteStop[];
}

export interface ListRoutesParams {
  page?: number;
  pageSize?: number;
  agentId?: string;
  supplierId?: string;
  weekday?: number;
  [key: string]: string | number | undefined;
}

export function useRoutesQuery(params: ListRoutesParams) {
  return useQuery({
    queryKey: ['routes', params],
    queryFn: () => apiFetch<PaginatedResult<Route>>(`/routes${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function useRouteQuery(id: string) {
  return useQuery({
    queryKey: ['routes', id],
    queryFn: () => apiFetch<Route>(`/routes/${id}`),
    enabled: !!id,
  });
}

export interface RouteInput {
  /** Exactly one of `agentId` / `supplierId` — enforced in the form, mirrors the API's CHECK constraint. */
  agentId?: string;
  supplierId?: string;
  weekday: number;
  name: string;
  stops: { outletId: string }[];
}

export function useCreateRouteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RouteInput) => apiFetch<Route>('/routes', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routes'] }),
  });
}

export function useUpdateRouteMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<RouteInput>) => apiFetch<Route>(`/routes/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routes'] });
      queryClient.invalidateQueries({ queryKey: ['routes', id] });
    },
  });
}
