import type { Metadata } from 'next';
import Script from 'next/script';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { Providers } from '@/components/providers';
import { TelegramInit } from '@/components/telegram-init';
import '../globals.css';

export const metadata: Metadata = {
  title: 'Velto Agent',
};

export const viewport = {
  // Bot API 7.x fullscreen mode can render behind the notch/home indicator —
  // globals.css pads env(safe-area-inset-*) to compensate.
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
  userScalable: false,
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    notFound();
  }
  const messages = await getMessages();

  return (
    // Telegram's own WebApp bridge script sets --tg-theme-* CSS custom
    // properties directly on this element as soon as it initializes
    // (theming), which happens before React hydrates — an unavoidable
    // client/server attribute mismatch on every real Telegram launch, not
    // just this dev tunnel. suppressHydrationWarning is Next.js's
    // documented fix for exactly this class of third-party DOM mutation.
    <html lang={locale} suppressHydrationWarning>
      <body>
        {/* beforeInteractive: window.Telegram must exist before AuthProvider's
            mount effect reads initData, and before hydration runs. */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        <NextIntlClientProvider messages={messages}>
          <Providers>
            <TelegramInit />
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
