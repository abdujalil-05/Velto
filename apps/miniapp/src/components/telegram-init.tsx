'use client';

import { useEffect } from 'react';
import { getTelegramWebApp } from '@/lib/telegram/webapp';

/** Runs Telegram's required startup handshake once: `ready()` tells Telegram the app finished loading (dismisses its loading placeholder), `expand()` requests the tallest available viewport (9.4's screens assume full height, not the collapsed half-sheet). No-op outside Telegram (PWA fallback). */
export function TelegramInit() {
  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;
    webApp.ready();
    webApp.expand();
  }, []);

  return null;
}
