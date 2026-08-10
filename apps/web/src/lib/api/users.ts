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
  /** Whether the user has linked their Telegram account (they /start the bot and share their phone; no admin-issued code exists). */
  telegramLinked: boolean;
  /** Optional — only sent by endpoints that carry the link timestamp. */
  telegramLinkedAt?: string | null;
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

/**
 * Rows still pointing at the user, keyed by table. Mirrors `countReferences()`
 * in `apps/api/src/modules/users/users.service.ts` — only non-zero counts are
 * sent, so every key is optional. Also arrives as `details.references` on the
 * 409 a `hard=true` delete throws.
 */
export interface UserReferences {
  salesOrders?: number;
  payments?: number;
  cashSessions?: number;
  routes?: number;
  visits?: number;
  courierOrders?: number;
  courierRoutes?: number;
  auditLogs?: number;
  exportJobs?: number;
  notifications?: number;
}

export interface DeleteUserResult {
  /** `soft` = anonymized + deactivated (history kept); `hard` = row physically gone. */
  mode: 'soft' | 'hard';
  id: string;
  references: UserReferences;
  /** The anonymized row on a soft delete; `null` once hard-deleted. */
  user: User | null;
}

/**
 * DELETE /users/:id — the API picks soft (anonymize) vs hard (physical) itself
 * based on whether anything still references the user, and reports which it did
 * via `mode`. `hard: true` turns that into an assertion: it 409s with
 * `details.references` instead of silently soft-deleting.
 */
export function useDeleteUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, hard }: { id: string; hard?: boolean }) =>
      // `hard: false` is the default — send the flag only when asserting, so the
      // URL stays a plain `/users/:id`.
      apiFetch<DeleteUserResult>(`/users/${id}${toQueryString({ hard: hard || undefined })}`, { method: 'DELETE' }),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['users', id] });
    },
  });
}
