'use client';

import { useEffect } from 'react';

/**
 * Registers the hand-written offline-shell worker (public/sw.js).
 * Only in production builds, or when NEXT_PUBLIC_ENABLE_SW=1, so `next dev`
 * (HMR) is never intercepted. ADR-010: Telegram iOS WebView may restrict
 * service workers / IndexedDB — registration failure is silent and the app
 * simply stays online-only for cold start; no full-offline promise is made.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    const enabled = process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_ENABLE_SW === '1';
    if (!enabled || !('serviceWorker' in navigator)) return;
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
    navigator.serviceWorker.register(`${base}/sw.js`, { scope: `${base}/` }).catch(() => {});
  }, []);
  return null;
}
