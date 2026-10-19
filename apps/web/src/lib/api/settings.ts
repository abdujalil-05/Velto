import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export type SubscriptionStatus = 'ACTIVE' | 'TRIAL' | 'TRIAL_EXPIRED';

export interface Subscription {
  plan: string;
  trialEndsAt: string | null;
  status: SubscriptionStatus;
  /** Calendar days (company timezone) until the trial ends; 0 once expired. */
  daysLeft: number;
}

// Mirrors apps/api/src/modules/settings/settings.service.ts (Company model, 6.2).
export interface CompanySettings {
  id: string;
  tenantId: string;
  name: string;
  legalName: string | null;
  phone: string | null;
  address: string | null;
  currency: string;
  defaultVatRate: string;
  docPrefix: string;
  timezone: string;
  visitGpsRadiusM: number;
  gpsMaxAccuracyM: number;
  isActive: boolean;
  subscription: Subscription;
}

export function useSettingsQuery(enabled = true) {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<CompanySettings>('/settings'),
    enabled,
  });
}

export interface UpdateSettingsInput {
  name?: string;
  legalName?: string;
  phone?: string;
  address?: string;
  currency?: string;
  defaultVatRate?: number;
  docPrefix?: string;
  timezone?: string;
  visitGpsRadiusM?: number;
  gpsMaxAccuracyM?: number;
}

export function useUpdateSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => apiFetch<CompanySettings>('/settings', { method: 'PATCH', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
}
