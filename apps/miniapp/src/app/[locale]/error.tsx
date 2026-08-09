'use client';

import { useEffect } from 'react';
import { TelegramFallback } from '@/components/telegram-fallback';

/**
 * Segment-level error boundary. Without one, any throw during render or
 * hydration below this segment unmounts the whole React root and leaves a
 * literally blank page — inside Telegram's WebView there is no console to
 * check either, so the app just "doesn't open". React re-renders this in
 * place of the failed subtree instead, so the agent always gets a readable
 * screen with a way back into the bot.
 *
 * `global-error.tsx` covers the narrower case of the root layout itself
 * throwing, which this boundary sits inside of and therefore cannot catch.
 */
export default function LocaleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[miniapp] unhandled client error', error);
  }, [error]);

  return <TelegramFallback reason="crash" detail={error.digest ?? error.message} onRetry={reset} />;
}
