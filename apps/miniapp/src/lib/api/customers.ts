import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface CustomerOutlet {
  id: string;
  name: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
}

export interface CustomerRecentOrder {
  id: string;
  number: string;
  status: string;
  createdAt: string;
  total: string;
}

export interface CustomerDetail {
  id: string;
  code: string;
  name: string;
  priceListId: string | null;
  isBlocked: boolean;
  cachedBalance: string;
  balance: string;
  outlets: CustomerOutlet[];
  recentOrders: CustomerRecentOrder[];
  lastPayment: { id: string; amount: string; createdAt: string } | null;
}

/** 9.4 Ekran 3: customer name, current debt, last order date for the Visit screen; also the source of `priceListId` for the Order screen's price preview (6.3). */
export function useCustomerQuery(customerId: string | null) {
  return useQuery({
    queryKey: ['customers', customerId],
    queryFn: () => apiFetch<CustomerDetail>(`/customers/${customerId}`),
    enabled: !!customerId,
  });
}
