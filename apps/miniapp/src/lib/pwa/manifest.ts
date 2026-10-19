import type { MetadataRoute } from 'next';

/** Matches --primary in globals.css (hsl 217 91% 40%). */
export const THEME_COLOR = '#0950c3';
export const BACKGROUND_COLOR = '#ffffff';

/**
 * Web app manifest for the PWA fallback (TZ 8.6) used outside Telegram. `basePath` is NEXT_PUBLIC_BASE_PATH
 * (reverse-proxy prefix) so start_url/scope stay inside the app. Icons are intentionally empty until brand
 * PNGs (192/512 + maskable) are supplied — never reference files that do not exist (the browser would treat
 * the app as not installable and the worker would cache 404s).
 */
export function buildManifest(basePath: string = ''): MetadataRoute.Manifest {
  return {
    name: 'Velto Agent',
    short_name: 'Velto',
    description: 'Velto sales agent app',
    start_url: `${basePath}/`,
    scope: `${basePath}/`,
    display: 'standalone',
    orientation: 'portrait',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [],
  };
}
