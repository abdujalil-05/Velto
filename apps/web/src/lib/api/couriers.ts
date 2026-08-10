/**
 * Couriers are ordinary `User` rows carrying the `COURIER` system role — there
 * is no `/couriers` endpoint. Everything here is a thin, courier-flavoured view
 * over the users API (`./users`), the same way the Agents screen filters on
 * `roleCode: 'SALES_AGENT'`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { useUsersQuery, type ListUsersParams, type User } from './users';

export const COURIER_ROLE_CODE = 'COURIER';

/** A courier is just a `User`; the alias keeps courier screens readable. */
export type Courier = User;

export type ListCouriersParams = Omit<ListUsersParams, 'roleCode'>;

export function useCouriersQuery(params: ListCouriersParams = {}, enabled = true) {
  return useUsersQuery({ ...params, roleCode: COURIER_ROLE_CODE }, enabled);
}

export interface CourierInput {
  firstName: string;
  lastName: string;
  phone: string;
}

export function useCreateCourierMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CourierInput) =>
      apiFetch<Courier>('/users', { method: 'POST', body: { ...input, roleCodes: [COURIER_ROLE_CODE] } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useUpdateCourierMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<CourierInput>) => apiFetch<Courier>(`/users/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['users', id] });
    },
  });
}

// --- Telegram link ---
//
// There is no admin-issued link code: the courier opens the company bot, presses
// /start and shares their phone, and the backend matches it to their account.
// Status therefore rides along on the user row (`telegramLinked`) — there is no
// telegram GET endpoint — and an admin can only revoke the link.

/** `DELETE /users/:id/telegram` — revokes the link; requires `users.update`. */
export function useUnlinkCourierTelegramMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (courierId: string) => apiFetch<void>(`/users/${courierId}/telegram`, { method: 'DELETE' }),
    onSuccess: (_data, courierId) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['users', courierId] });
    },
  });
}

/** `"Firstname Lastname"` for display — couriers are shown by full name everywhere. */
export function courierName(courier: Pick<Courier, 'firstName' | 'lastName'>): string {
  return `${courier.firstName} ${courier.lastName}`.trim();
}
