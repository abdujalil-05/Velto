import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface Warehouse {
  id: string;
  name: string;
  address: string | null;
  isActive: boolean;
}

/** ICP is 1-3 warehouses (2.4) — a single unpaginated list is fine. */
export function useWarehousesQuery(enabled = true) {
  return useQuery({
    queryKey: ['warehouses'],
    queryFn: () => apiFetch<Warehouse[]>('/warehouses'),
    enabled,
  });
}

/** Every company has exactly one warehouse — this fetches (and lazily provisions) it. */
export function useDefaultWarehouseQuery(enabled = true) {
  return useQuery({
    queryKey: ['warehouses', 'default'],
    queryFn: () => apiFetch<Warehouse>('/warehouses/default'),
    enabled,
  });
}

export interface CreateWarehouseInput {
  name: string;
  address?: string;
}

export function useCreateWarehouseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWarehouseInput) => apiFetch<Warehouse>('/warehouses', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}

export function useDeactivateWarehouseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<Warehouse>(`/warehouses/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}
