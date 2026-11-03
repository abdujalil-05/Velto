import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';

/** 9.4-follow-up "marshrutni tugatish" — direct online call, not routed through the offline queue: the useful part of this action is the server telling you which stops are still missing, which requires a real round-trip anyway. */
export function useFinishRouteMutation() {
  return useMutation({
    mutationFn: (routeId: string) => apiFetch<{ id: string; routeId: string; date: string; completedAt: string | null }>(`/routes/${routeId}/finish`, { method: 'POST' }),
  });
}

export interface OpenRouteStop {
  outletId: string;
  outletName: string;
  /** NO_VISIT, or the latest visit's GpsStatus. */
  reason: string;
}

export function openStopsFrom(details: unknown): OpenRouteStop[] {
  const list = (details as { openStops?: unknown } | undefined)?.openStops;
  return Array.isArray(list) ? (list as OpenRouteStop[]) : [];
}

/** POST /routes/:id/skip-stop — closes a stop that cannot be GPS-verified; reason is required. Online-only like finish. */
export function useSkipStopMutation() {
  return useMutation({
    mutationFn: (input: { routeId: string; outletId: string; reason: string }) =>
      apiFetch<unknown>(`/routes/${input.routeId}/skip-stop`, { method: 'POST', body: { outletId: input.outletId, reason: input.reason } }),
  });
}
