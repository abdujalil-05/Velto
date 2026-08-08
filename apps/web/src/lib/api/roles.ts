import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface Role {
  id: string;
  code: string;
  name: string;
}

// GET /roles — read-only, only isSystem roles (5.4: custom-role authoring is [v1.1]).
export function useRolesQuery(enabled = true) {
  return useQuery({
    queryKey: ['roles'],
    queryFn: () => apiFetch<Role[]>('/roles'),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
