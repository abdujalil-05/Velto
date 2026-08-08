import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface ProductCategory {
  id: string;
  name: string;
  parentId: string | null;
}

/** Distributors run a small, mostly-flat category tree (6.4) — one unpaginated list covers the dropdown. */
export function useCategoriesQuery() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch<ProductCategory[]>('/categories'),
  });
}

export interface CreateCategoryInput {
  name: string;
  parentId?: string;
}

export function useCreateCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryInput) => apiFetch<ProductCategory>('/categories', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['categories'] }),
  });
}
