import type { GeolocationState } from '@/lib/hooks/use-geolocation';

/** GPS fields of POST /visits and of the queued visit payload. Never includes gpsOk/gpsStatus — the server derives them and rejects client-sent values. */
export interface VisitGpsFields {
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  capturedAt?: string;
  permissionDenied?: boolean;
}

export type GpsFixInput = Pick<GeolocationState, 'latitude' | 'longitude' | 'accuracyM' | 'capturedAt' | 'permissionDenied'>;

export function buildVisitGpsFields(geo: GpsFixInput): VisitGpsFields {
  if (geo.permissionDenied) return { permissionDenied: true };
  if (geo.latitude == null || geo.longitude == null) return {};
  return {
    latitude: geo.latitude,
    longitude: geo.longitude,
    ...(geo.accuracyM != null ? { accuracyM: geo.accuracyM } : {}),
    ...(geo.capturedAt ? { capturedAt: geo.capturedAt } : {}),
  };
}

/**
 * In-memory handoff of the visit GPS fix from the visit page to /order/new (TZ §11.3: coordinates must never
 * appear in the URL / webview history). Module state only: lost on reload, in which case the order page
 * degrades to no coordinates (NO_FIX) instead of failing.
 */
const gpsHandoff = new Map<string, VisitGpsFields>();

export function stashVisitGps(outletId: string, fields: VisitGpsFields): void {
  gpsHandoff.set(outletId, { ...fields });
}

/** Returns the stashed fields (or {} if lost) without consuming them, so a re-render keeps working. */
export function peekVisitGps(outletId: string): VisitGpsFields {
  return { ...(gpsHandoff.get(outletId) ?? {}) };
}

export function clearVisitGps(outletId: string): void {
  gpsHandoff.delete(outletId);
}

export type GpsStatus = 'VERIFIED' | 'OUTSIDE_RADIUS' | 'LOW_ACCURACY' | 'NO_PERMISSION' | 'NO_FIX' | 'OUTLET_NO_COORDS';

/** Status the device can know before the server answers (thresholds/distance are server-side, so VERIFIED/OUTSIDE_RADIUS/LOW_ACCURACY are never guessed here). */
export function localGpsStatus(fields: VisitGpsFields, outletHasCoords: boolean): GpsStatus | null {
  if (fields.permissionDenied) return 'NO_PERMISSION';
  if (fields.latitude == null || fields.longitude == null) return 'NO_FIX';
  if (!outletHasCoords) return 'OUTLET_NO_COORDS';
  return null;
}
