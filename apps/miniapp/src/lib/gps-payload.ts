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

/** Serialises the GPS fields into the /order/new handoff query (the visit is enqueued there once the order is saved). */
export function gpsFieldsToSearchParams(fields: VisitGpsFields, into: URLSearchParams): void {
  if (fields.latitude != null) into.set('visitLat', String(fields.latitude));
  if (fields.longitude != null) into.set('visitLng', String(fields.longitude));
  if (fields.accuracyM != null) into.set('visitAcc', String(fields.accuracyM));
  if (fields.capturedAt) into.set('visitAt', fields.capturedAt);
  if (fields.permissionDenied) into.set('visitDenied', '1');
}

export function gpsFieldsFromSearchParams(sp: URLSearchParams): VisitGpsFields {
  if (sp.get('visitDenied') === '1') return { permissionDenied: true };
  const lat = sp.get('visitLat');
  const lng = sp.get('visitLng');
  if (lat == null || lng == null || lat === '' || lng === '' || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) return {};
  const acc = sp.get('visitAcc');
  const at = sp.get('visitAt');
  return {
    latitude: Number(lat),
    longitude: Number(lng),
    ...(acc != null && acc !== '' && !Number.isNaN(Number(acc)) ? { accuracyM: Number(acc) } : {}),
    ...(at ? { capturedAt: at } : {}),
  };
}

export type GpsStatus = 'VERIFIED' | 'OUTSIDE_RADIUS' | 'LOW_ACCURACY' | 'NO_PERMISSION' | 'NO_FIX' | 'OUTLET_NO_COORDS';

/** Status the device can know before the server answers (thresholds/distance are server-side, so VERIFIED/OUTSIDE_RADIUS/LOW_ACCURACY are never guessed here). */
export function localGpsStatus(fields: VisitGpsFields, outletHasCoords: boolean): GpsStatus | null {
  if (fields.permissionDenied) return 'NO_PERMISSION';
  if (fields.latitude == null || fields.longitude == null) return 'NO_FIX';
  if (!outletHasCoords) return 'OUTLET_NO_COORDS';
  return null;
}
