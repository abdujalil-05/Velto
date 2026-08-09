'use client';

import { useTranslations } from 'next-intl';
import { ExternalLink, RotateCw, Send } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// The bot's @username, used to build the t.me deep link back into the Mini
// App. There is no server-side source for it (the API only stores
// TELEGRAM_BOT_TOKEN, never the username — see apps/api env.schema.ts), so it
// is read from a build-time public env var. Referenced as a full literal
// `process.env.NEXT_PUBLIC_...` expression because Next.js inlines these by
// textual substitution — destructuring or indexing `process.env` yields
// `undefined` in the browser bundle.
//
// Unset is a supported state, not a crash: the deep-link button is simply
// omitted and the user still gets the explanation plus "Retry". Never guess a
// username here — a wrong t.me link sends agents to a stranger's bot.
//
// Read inside the function rather than into a module-level const: the value is
// still a full literal `process.env.NEXT_PUBLIC_...` expression (so Next's
// textual inlining works exactly the same), but evaluating it per render keeps
// both states — configured and unconfigured — reachable from tests, which run
// outside Next's transform and would otherwise be frozen to whatever
// `process.env` held at import time.
function botUsername(): string {
  return (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '').trim();
}

/** `null` when no bot username is configured — callers must handle that. */
function botDeepLink(): string | null {
  const username = botUsername();
  if (!username) return null;
  return `https://t.me/${username}`;
}

export interface TelegramFallbackProps {
  /** Which explanation to show: opened outside Telegram, or opened inside Telegram but the session could not be established. */
  reason: 'no-telegram-context' | 'unauthenticated' | 'crash';
  /** Optional extra detail (an error code/message) rendered in small monospace — diagnostics for the agent to relay, never the primary message. */
  detail?: string;
  /** Overrides the default "reload the page" retry (used by the error boundary, which passes React's `reset`). */
  onRetry?: () => void;
}

/**
 * The screen shown whenever the Mini App cannot get as far as a real UI:
 * opened outside Telegram, `initData` missing/rejected, or an unhandled client
 * error. Before this existed every one of those paths rendered either `null`
 * or a single line of muted text, which on a phone is indistinguishable from a
 * blank screen — the app looked broken with no way forward.
 *
 * Always renders a way out: the bot deep link (when configured) and a retry.
 */
export function TelegramFallback({ reason, detail, onRetry }: TelegramFallbackProps) {
  const t = useTranslations('Auth');
  const link = botDeepLink();

  const bodyKey =
    reason === 'crash' ? 'fallbackCrashBody' : reason === 'unauthenticated' ? 'fallbackSessionBody' : 'fallbackBody';

  const retry = () => {
    if (onRetry) {
      onRetry();
      return;
    }
    window.location.reload();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Send className="h-7 w-7" aria-hidden />
      </div>

      <div className="space-y-2">
        <h1 className="text-base font-semibold">{t('fallbackTitle')}</h1>
        <p className="max-w-xs text-sm text-muted-foreground">{t(bodyKey)}</p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            {t('openInTelegram')}
          </a>
        ) : (
          // No NEXT_PUBLIC_TELEGRAM_BOT_USERNAME at build time. Say so plainly
          // rather than rendering a dead button or an invented @username.
          <p className="text-xs text-muted-foreground">{t('botLinkUnavailable')}</p>
        )}

        <Button variant="outline" size="lg" className="w-full gap-2" onClick={retry}>
          <RotateCw className="h-4 w-4" aria-hidden />
          {t('retry')}
        </Button>
      </div>

      {detail ? <p className="max-w-xs break-words font-mono text-[11px] text-muted-foreground/70">{detail}</p> : null}
    </div>
  );
}
