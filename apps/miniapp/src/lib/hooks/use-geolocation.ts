'use client';

import { useEffect, useState } from 'react';

export interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  error: string | null;
  loading: boolean;
}

/** 9.4 "GPS avtomatik olinadi" — browser Geolocation API (works both inside Telegram's WebView and as a standalone PWA; Telegram's own location-request API needs Bot API 8.0+ which isn't guaranteed available on every client). */
export function useGeolocation(): GeolocationState {
  const [state, setState] = useState<GeolocationState>({ latitude: null, longitude: null, error: null, loading: true });

  useEffect(() => {
    if (!navigator.geolocation) {
      setState({ latitude: null, longitude: null, error: 'unsupported', loading: false });
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setState({ latitude: position.coords.latitude, longitude: position.coords.longitude, error: null, loading: false });
      },
      (error) => {
        setState({ latitude: null, longitude: null, error: error.message, loading: false });
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return state;
}
