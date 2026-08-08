import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

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
  isActive: boolean;
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
}

export function useUpdateSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => apiFetch<CompanySettings>('/settings', { method: 'PATCH', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
}
