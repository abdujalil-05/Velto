import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';

/** 9.4-follow-up "marshrutni tugatish" — direct online call, not routed through the offline queue: the useful part of this action is the server telling you which stops are still missing, which requires a real round-trip anyway. */
export function useFinishRouteMutation() {
  return useMutation({
    mutationFn: (routeId: string) => apiFetch<{ id: string; routeId: string; date: string; completedAt: string | null }>(`/routes/${routeId}/finish`, { method: 'POST' }),
  });
}
