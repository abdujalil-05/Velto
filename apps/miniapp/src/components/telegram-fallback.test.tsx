import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import uz from '../../messages/uz.json';
import ru from '../../messages/ru.json';
import en from '../../messages/en.json';
import { TelegramFallback } from './telegram-fallback';

// Regression guard for the blank-screen bug: every "cannot start" path
// (outside Telegram, dead session, unhandled client error) must render
// readable text and an actionable control. Rendering to static markup is
// enough — the failure mode being guarded against is an empty subtree, and
// asserting on real translated strings also catches a key missing from any
// one locale.
function render(node: React.ReactElement, locale: string, messages: Record<string, unknown>) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages as never}>
      {node}
    </NextIntlClientProvider>,
  );
}

/** Uzbek strings carry `'` (o'zbek, ko'ring), which React escapes to `&#x27;` in markup — compare against the escaped form, not the raw message. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const locales = [
  { code: 'uz', messages: uz as Record<string, unknown> },
  { code: 'ru', messages: ru as Record<string, unknown> },
  { code: 'en', messages: en as Record<string, unknown> },
];

describe('TelegramFallback', () => {
  for (const { code, messages } of locales) {
    const auth = (messages.Auth as Record<string, string>) ?? {};

    it(`renders a non-empty screen with the retry control in ${code}`, () => {
      const html = render(<TelegramFallback reason="no-telegram-context" />, code, messages);

      expect(html).toContain(esc(auth.fallbackTitle));
      expect(html).toContain(esc(auth.fallbackBody));
      expect(html).toContain(esc(auth.retry));
      expect(html).toContain('<button');
      // The whole point: never an empty render.
      expect(html.replace(/<[^>]*>/g, '').trim().length).toBeGreaterThan(20);
    });

    it(`uses a distinct explanation per reason in ${code}`, () => {
      const session = render(<TelegramFallback reason="unauthenticated" />, code, messages);
      const crash = render(<TelegramFallback reason="crash" />, code, messages);

      expect(session).toContain(esc(auth.fallbackSessionBody));
      expect(crash).toContain(esc(auth.fallbackCrashBody));
    });
  }

  it('renders the diagnostic detail when one is supplied', () => {
    const html = render(<TelegramFallback reason="crash" detail="digest-abc123" />, 'en', en as never);
    expect(html).toContain('digest-abc123');
  });

  describe('bot deep link', () => {
    // NEXT_PUBLIC_TELEGRAM_BOT_USERNAME is a build-time inlined var; under
    // vitest it is a plain env read, so both deployment states are exercised
    // here. Restore it after each case so test order cannot leak.
    const original = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

    afterEach(() => {
      if (original === undefined) delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
      else process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = original;
    });

    it('degrades to a readable notice instead of a dead link when no bot username is configured', () => {
      // Must never render an href to a guessed or empty t.me handle.
      delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

      const html = render(<TelegramFallback reason="no-telegram-context" />, 'en', en as never);
      const auth = en.Auth as Record<string, string>;

      expect(html).toContain(esc(auth.botLinkUnavailable));
      expect(html).not.toContain('https://t.me/"');
      expect(html).not.toContain('href="https://t.me/');
    });

    it('renders the deep link (and drops the notice) when a bot username is configured', () => {
      process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = '@veltoai_bot';

      const auth = en.Auth as Record<string, string>;
      const html = render(<TelegramFallback reason="no-telegram-context" />, 'en', en as never);

      // The leading `@` is stripped — `t.me/@name` is not a valid deep link.
      expect(html).toContain('href="https://t.me/veltoai_bot"');
      expect(html).toContain(esc(auth.openInTelegram));
      expect(html).not.toContain(esc(auth.botLinkUnavailable));
    });

    it('opens the link out of the webview safely', () => {
      process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = 'veltoai_bot';

      const html = render(<TelegramFallback reason="unauthenticated" />, 'uz', uz as never);

      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('target="_blank"');
    });
  });
});
