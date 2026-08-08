import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { toQueryString } from './query-string';
import type { PaginatedResult } from './types';

export type OutletType = 'SHOP' | 'MINIMARKET' | 'SUPERMARKET' | 'BAZAAR' | 'HORECA' | 'WAREHOUSE' | 'OTHER';
export type OrderStatus = 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CLOSED' | 'CANCELLED';
export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';
export type VisitOutcome = 'ORDERED' | 'NO_ORDER';

// Mirrors packages/database/prisma/schema.prisma (6.3) — Decimal fields
// arrive as strings.
export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  contactPerson: string | null;
  priceListId: string | null;
  paymentTermDays: number;
  isBlocked: boolean;
  blockReason: string | null;
  cachedBalance: string;
  isActive: boolean;
  createdAt: string;
}

export interface Outlet {
  id: string;
  customerId: string;
  name: string;
  type: OutletType;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  isActive: boolean;
}

export interface CustomerOrderSummary {
  id: string;
  number: string;
  status: OrderStatus;
  createdAt: string;
  total: string;
}

export interface CustomerVisit {
  id: string;
  startedAt: string;
  endedAt: string | null;
  outcome: VisitOutcome;
  noOrderReason: string | null;
  outlet: { name: string };
}

export interface CustomerPayment {
  id: string;
  number: string;
  amount: string;
  method: PaymentMethod;
  createdAt: string;
}

export interface CustomerDetail extends Customer {
  outlets: Outlet[];
  priceList: { id: string; name: string } | null;
  balance: string;
  recentOrders: CustomerOrderSummary[];
  lastPayment: CustomerPayment | null;
  recentVisits: CustomerVisit[];
}

export interface ListCustomersParams {
  page?: number;
  pageSize?: number;
  search?: string;
  isBlocked?: boolean;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  [key: string]: string | number | boolean | undefined;
}

export function useCustomersQuery(params: ListCustomersParams) {
  return useQuery({
    queryKey: ['customers', params],
    queryFn: () => apiFetch<PaginatedResult<Customer>>(`/customers${toQueryString(params)}`),
    placeholderData: (previous) => previous,
  });
}

export function useCustomerQuery(id: string) {
  return useQuery({
    queryKey: ['customers', id],
    queryFn: () => apiFetch<CustomerDetail>(`/customers/${id}`),
    enabled: !!id,
  });
}

// Outlets can only be listed per-customer — there's no standalone /outlets
// search endpoint (customers/outlets/outlets.controller.ts).
export function useCustomerOutletsQuery(customerId: string | null) {
  return useQuery({
    queryKey: ['customers', customerId, 'outlets'],
    queryFn: () => apiFetch<Outlet[]>(`/customers/${customerId}/outlets`),
    enabled: !!customerId,
  });
}

export interface OutletInput {
  name: string;
  type?: OutletType;
  address?: string;
}

export interface CustomerFormInput {
  code: string;
  name: string;
  phone?: string;
  contactPerson?: string;
  priceListId?: string;
  paymentTermDays?: number;
  outlets?: OutletInput[];
}

export interface DuplicateWarning {
  type: 'PHONE' | 'NAME_SIMILARITY' | 'LOCATION_PROXIMITY';
  customerId: string;
  customerName: string;
  detail: string;
}

interface MutateCustomerResult {
  customer: Customer;
  warnings: DuplicateWarning[];
}

export function useCreateCustomerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerFormInput) => apiFetch<MutateCustomerResult>('/customers', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers'] }),
  });
}

export function useUpdateCustomerMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<CustomerFormInput>) =>
      apiFetch<MutateCustomerResult>(`/customers/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customers', id] });
    },
  });
}

export function useBlockCustomerMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => apiFetch<Customer>(`/customers/${id}/block`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customers', id] });
    },
  });
}

export function useUnblockCustomerMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<Customer>(`/customers/${id}/unblock`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customers', id] });
    },
  });
}
