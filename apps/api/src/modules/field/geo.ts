const EARTH_RADIUS_M = 6_371_000;

/** Haversine great-circle distance in meters between two lat/lng points. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export type GpsStatusValue = 'VERIFIED' | 'OUTSIDE_RADIUS' | 'LOW_ACCURACY' | 'NO_PERMISSION' | 'NO_FIX' | 'OUTLET_NO_COORDS';

export interface GpsEvaluationInput {
  permissionDenied?: boolean;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  outletLatitude?: number | null;
  outletLongitude?: number | null;
  radiusM: number;
  maxAccuracyM: number;
}

export interface GpsEvaluation {
  status: GpsStatusValue;
  /** Agent coordinates actually stored (null for NO_PERMISSION / NO_FIX). */
  latitude: number | null;
  longitude: number | null;
  /** Metres, rounded to 2 decimals; null when it could not be computed. */
  distanceM: number | null;
}

/**
 * F3: server-side GPS classification. Precedence (first match wins):
 * 1 NO_PERMISSION (client says permission denied) ->
 * 2 NO_FIX (no complete lat/lng pair) ->
 * 3 OUTLET_NO_COORDS (outlet has no coordinates) ->
 * 4 LOW_ACCURACY (accuracy > maxAccuracyM; equal passes) ->
 * 5 OUTSIDE_RADIUS (distance > radiusM; exactly radius is VERIFIED) ->
 * 6 VERIFIED. The decision uses the same 2-decimal-rounded distance that is stored.
 */
export function evaluateGps(input: GpsEvaluationInput): GpsEvaluation {
  const hasFix = input.latitude != null && input.longitude != null;
  if (input.permissionDenied) return { status: 'NO_PERMISSION', latitude: null, longitude: null, distanceM: null };
  if (!hasFix) return { status: 'NO_FIX', latitude: null, longitude: null, distanceM: null };
  const latitude = input.latitude as number;
  const longitude = input.longitude as number;
  if (input.outletLatitude == null || input.outletLongitude == null) {
    return { status: 'OUTLET_NO_COORDS', latitude, longitude, distanceM: null };
  }
  const distanceM = Math.round(distanceMeters(latitude, longitude, input.outletLatitude, input.outletLongitude) * 100) / 100;
  if (input.accuracyM != null && input.accuracyM > input.maxAccuracyM) {
    return { status: 'LOW_ACCURACY', latitude, longitude, distanceM };
  }
  if (distanceM > input.radiusM) return { status: 'OUTSIDE_RADIUS', latitude, longitude, distanceM };
  return { status: 'VERIFIED', latitude, longitude, distanceM };
}
