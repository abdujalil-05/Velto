'use client';

import { useEffect } from 'react';
import { getTelegramWebApp } from '@/lib/telegram/webapp';

/** Shows Telegram's hardware back button on non-home screens and wires it to `onBack`; hides it again on unmount. No-op outside Telegram (PWA fallback falls back to the browser's own back navigation). */
export function useTelegramBackButton(onBack: () => void): void {
  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;

    webApp.BackButton.onClick(onBack);
    webApp.BackButton.show();
    return () => {
      webApp.BackButton.offClick(onBack);
      webApp.BackButton.hide();
    };
  }, [onBack]);
}
