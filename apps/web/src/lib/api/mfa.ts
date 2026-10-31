import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { TokenPair } from './types';

// ADR-058. Challenges and codes live in component state only: never persisted, never logged.
export interface MfaChallenge {
  mfa: 'verify' | 'enroll';
  mfaChallenge: string;
  expiresIn: number;
}

export function isMfaChallenge(r: unknown): r is MfaChallenge {
  const m = (r as MfaChallenge | null | undefined)?.mfa;
  return (m === 'verify' || m === 'enroll') && typeof (r as MfaChallenge).mfaChallenge === 'string';
}

export interface MfaEnrollStart {
  otpauthUri: string;
  secret: string;
  qrDataUrl: string;
}

export interface MfaEnrollConfirmResult extends TokenPair {
  recoveryCodes: string[];
}

export function mfaEnrollStartRequest(mfaChallenge: string, enrollmentCode?: string) {
  return apiFetch<MfaEnrollStart>('/auth/mfa/enroll/start', {
    method: 'POST',
    body: enrollmentCode ? { mfaChallenge, enrollmentCode } : { mfaChallenge },
    skipAuth: true,
  });
}

export function mfaEnrollConfirmRequest(mfaChallenge: string, code: string, enrollmentCode?: string) {
  return apiFetch<MfaEnrollConfirmResult>('/auth/mfa/enroll/confirm', {
    method: 'POST',
    body: enrollmentCode ? { mfaChallenge, code, enrollmentCode } : { mfaChallenge, code },
    skipAuth: true,
  });
}

export function mfaVerifyRequest(mfaChallenge: string, input: { code: string } | { recoveryCode: string }) {
  return apiFetch<TokenPair>('/auth/mfa/verify', {
    method: 'POST',
    body: { mfaChallenge, ...input },
    skipAuth: true,
  });
}

export function useMfaReenrollMutation() {
  return useMutation({
    mutationFn: (body: { password: string; code: string }) =>
      apiFetch<MfaChallenge>('/auth/mfa/reenroll', { method: 'POST', body }),
  });
}

export function useRegenerateRecoveryCodesMutation() {
  return useMutation({
    mutationFn: (body: { code: string }) =>
      apiFetch<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes/regenerate', { method: 'POST', body }),
  });
}

export function useResetUserMfaMutation() {
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<{ reset: boolean; sessionsRevoked: number }>(`/users/${id}/mfa/reset`, {
        method: 'POST',
        body: { reason },
      }),
  });
}

// One-time out-of-band enrollment code: mutation result is shown once; never cached or persisted.
export function useIssueMfaEnrollmentCodeMutation() {
  return useMutation({
    gcTime: 0,
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<{ code: string; expiresAt: string }>(`/users/${id}/mfa/enrollment-code`, { method: 'POST' }),
  });
}
