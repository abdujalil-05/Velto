import Link from 'next/link';
import { getMessages } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import './globals.css';

export default async function RootNotFound() {
  const messages = (await getMessages({ locale: routing.defaultLocale })) as unknown as {
    NotFound: { title: string; description: string; homeAction: string };
  };
  const t = messages.NotFound;

  return (
    <html lang={routing.defaultLocale} suppressHydrationWarning>
      <body>
        <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-lg font-semibold">{t.title}</h1>
          <p className="max-w-xs text-sm text-muted-foreground">{t.description}</p>
          <Link
            href={`/${routing.defaultLocale}`}
            className="inline-flex h-12 w-full items-center justify-center rounded-md bg-primary px-8 text-base font-medium text-primary-foreground"
          >
            {t.homeAction}
          </Link>
        </div>
      </body>
    </html>
  );
}
