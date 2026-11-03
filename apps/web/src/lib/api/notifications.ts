import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { LocalizedMessage, PaginatedResult } from './types';

// Mirrors the Notification model (packages/database schema) as returned by
// apps/api/src/modules/notifications — title/message are stored already localized.
export interface AppNotification {
  id: string;
  /** e.g. "order.on_hold", "reconciliation.drift", "field.gps_unverified", "field.outlet_no_coords" */
  type: string;
  title: LocalizedMessage;
  message: LocalizedMessage;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ListNotificationsParams {
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
}

const UNREAD_POLL_MS = 60_000;

export function useUnreadCountQuery() {
  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => apiFetch<{ count: number }>('/notifications/unread-count'),
    refetchInterval: UNREAD_POLL_MS,
  });
}

export function useNotificationsQuery(params: ListNotificationsParams, enabled: boolean) {
  return useQuery({
    queryKey: ['notifications', 'list', params],
    queryFn: () => apiFetch<PaginatedResult<AppNotification>>(`/notifications${toQueryString({ ...params })}`),
    enabled,
  });
}

export function useMarkNotificationReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<AppNotification>(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useMarkAllNotificationsReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ success: boolean }>('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
