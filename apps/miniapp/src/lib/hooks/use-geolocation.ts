'use client';

import { useEffect, useState } from 'react';

export interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  /** Horizontal accuracy in metres, as reported by the device. */
  accuracyM: number | null;
  /** ISO time of the fix (position.timestamp). */
  capturedAt: string | null;
  /** True only when the user/OS denied location access (error code 1). */
  permissionDenied: boolean;
  error: string | null;
  loading: boolean;
}

const EMPTY: GeolocationState = {
  latitude: null,
  longitude: null,
  accuracyM: null,
  capturedAt: null,
  permissionDenied: false,
  error: null,
  loading: false,
};

/** 9.4 "GPS avtomatik olinadi" — browser Geolocation API (works both inside Telegram's WebView and as a standalone PWA; Telegram's own location-request API needs Bot API 8.0+ which isn't guaranteed available on every client). The server decides the GPS status; this hook only reports what the device gave us. */
export function useGeolocation(): GeolocationState {
  const [state, setState] = useState<GeolocationState>({ ...EMPTY, loading: true });

  useEffect(() => {
    if (!navigator.geolocation) {
      setState({ ...EMPTY, error: 'unsupported' });
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setState({
          ...EMPTY,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          capturedAt: new Date(position.timestamp).toISOString(),
        });
      },
      (error) => {
        // PERMISSION_DENIED = 1; TIMEOUT = 3 / POSITION_UNAVAILABLE = 2 are "no fix", not "denied".
        setState({ ...EMPTY, permissionDenied: error.code === 1, error: error.message });
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return state;
}
