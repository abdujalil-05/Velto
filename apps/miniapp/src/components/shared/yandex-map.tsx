'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { MapPin } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

// No @types package for the Yandex Maps JS API in this repo — a minimal
// shape for the handful of calls this component makes, not a full typing.
interface YandexPlacemark {
  new (coords: [number, number], properties?: Record<string, unknown>, options?: Record<string, unknown>): unknown;
}
interface YandexMapInstance {
  geoObjects: { add: (obj: unknown) => void; removeAll: () => void };
  setCenter: (coords: [number, number], zoom?: number) => void;
  destroy: () => void;
}
interface YandexMapsApi {
  ready: (cb: () => void) => void;
  Map: new (el: HTMLElement, state: { center: [number, number]; zoom: number }) => YandexMapInstance;
  Placemark: YandexPlacemark;
}
declare global {
  interface Window {
    ymaps?: YandexMapsApi;
  }
}

const API_KEY = process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY ?? '';
const LANG_BY_LOCALE: Record<string, string> = { uz: 'uz_UZ', ru: 'ru_RU', en: 'en_US' };

let scriptPromise: Promise<YandexMapsApi> | null = null;

/** Loads the Yandex Maps JS API script once per page (cached across every YandexMap instance) and resolves once `ymaps` is ready. */
function loadYandexMaps(lang: string): Promise<YandexMapsApi> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(API_KEY)}&lang=${lang}`;
    script.async = true;
    script.onload = () => {
      if (!window.ymaps) {
        reject(new Error('Yandex Maps script loaded but window.ymaps is missing'));
        return;
      }
      window.ymaps.ready(() => resolve(window.ymaps!));
    };
    script.onerror = () => reject(new Error('Failed to load Yandex Maps script'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface YandexMapProps {
  /** The outlet's registered position — omit when the outlet has no coordinates. */
  outletLat?: number | null;
  outletLng?: number | null;
  /** The agent's live position, from useGeolocation() — updates re-center the agent's placemark without reloading the map. */
  agentLat?: number | null;
  agentLng?: number | null;
  className?: string;
}

/** 9.4-follow-up: outlet pin + the agent's own live position, visual reference only — no routing/directions. */
export function YandexMap({ outletLat, outletLng, agentLat, agentLng, className }: YandexMapProps) {
  const t = useTranslations('Common');
  const locale = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<YandexMapInstance | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!API_KEY || !containerRef.current) return;
    let cancelled = false;

    loadYandexMaps(LANG_BY_LOCALE[locale] ?? 'en_US')
      .then((ymaps) => {
        if (cancelled || !containerRef.current) return;
        const center: [number, number] =
          outletLat != null && outletLng != null ? [outletLat, outletLng] : agentLat != null && agentLng != null ? [agentLat, agentLng] : [41.2995, 69.2401];
        const map = new ymaps.Map(containerRef.current, { center, zoom: 16 });
        mapRef.current = map;
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
    // Re-init only when the outlet changes — placemarks are refreshed by the effect below without recreating the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletLat, outletLng, locale]);

  useEffect(() => {
    const map = mapRef.current;
    const ymaps = window.ymaps;
    if (!map || !ymaps) return;
    map.geoObjects.removeAll();
    if (outletLat != null && outletLng != null) {
      map.geoObjects.add(new ymaps.Placemark([outletLat, outletLng], {}, { preset: 'islands#redDotIcon' }));
    }
    if (agentLat != null && agentLng != null) {
      map.geoObjects.add(new ymaps.Placemark([agentLat, agentLng], {}, { preset: 'islands#blueCircleIcon' }));
    }
  });

  if (!API_KEY || error) {
    return (
      <Card className={className}>
        <CardContent className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
          <MapPin className="h-5 w-5" />
          {t('mapUnavailable')}
        </CardContent>
      </Card>
    );
  }

  return <div ref={containerRef} className={className} style={{ minHeight: 220 }} />;
}
