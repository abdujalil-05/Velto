import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { TokenPair } from './types';

// ADR-057: ids are opaque single-use options; never persist them beyond component state.
export interface CompanyChoice {
  id: string;
  name: string;
}

export interface CompanySelectionRequired {
  requiresCompanySelection: true;
  challengeId: string;
  companies: CompanyChoice[];
}

export type LoginResponse = TokenPair | CompanySelectionRequired;

export function isCompanySelection(r: LoginResponse): r is CompanySelectionRequired {
  return (r as CompanySelectionRequired).requiresCompanySelection === true;
}

export function loginRequest(phone: string, password: string) {
  return apiFetch<LoginResponse>('/auth/login', { method: 'POST', body: { phone, password }, skipAuth: true });
}

export function selectCompanyRequest(challengeId: string, optionId: string) {
  return apiFetch<TokenPair>('/auth/login/select-company', {
    method: 'POST',
    body: { challengeId, optionId },
    skipAuth: true,
  });
}

// ADR-057a
export interface AccountSelectionRequired {
  requiresAccountSelection: true;
  resetHandle: string;
  accounts: CompanyChoice[];
}

export function useConfirmPasswordResetMutation() {
  return useMutation({
    mutationFn: (body: { phone: string; code: string; newPassword: string }) =>
      apiFetch<AccountSelectionRequired | undefined>('/auth/password-reset/confirm', {
        method: 'POST',
        body,
        skipAuth: true,
      }),
  });
}

export function useSelectResetAccountMutation() {
  return useMutation({
    mutationFn: (body: { resetHandle: string; optionId: string; newPassword: string }) =>
      apiFetch<void>('/auth/password-reset/select-account', { method: 'POST', body, skipAuth: true }),
  });
}
