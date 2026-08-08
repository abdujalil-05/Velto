import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { id: string; code: string; name: string }[];
}

export interface ListUsersParams {
  page?: number;
  pageSize?: number;
  search?: string;
  isActive?: boolean;
  roleCode?: string;
  [key: string]: string | number | boolean | undefined;
}

export function useUsersQuery(params: ListUsersParams, enabled = true) {
  return useQuery({
    queryKey: ['users', params],
    queryFn: () => apiFetch<PaginatedResult<User>>(`/users${toQueryString(params)}`),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useUserQuery(id: string) {
  return useQuery({
    queryKey: ['users', id],
    queryFn: () => apiFetch<User>(`/users/${id}`),
    enabled: !!id,
  });
}

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  password?: string;
  roleCodes: string[];
}

export type UpdateUserInput = Partial<CreateUserInput>;

export function useCreateUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => apiFetch<User>('/users', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useUpdateUserMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateUserInput) => apiFetch<User>(`/users/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['users', id] });
    },
  });
}

export function useActivateUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<User>(`/users/${id}/activate`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useDeactivateUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<User>(`/users/${id}/deactivate`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
}
