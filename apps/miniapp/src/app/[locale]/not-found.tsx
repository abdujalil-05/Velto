'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { SearchX } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Rendered for any URL under /[locale] that matches no route (see the
// [...rest] catch-all, which is what actually routes an unknown path here)
// and for any notFound() thrown inside the locale segment. Deliberately
// static/offline-safe: no queries, no auth gate — a mistyped deep link must
// render the same with or without a connection (10.x).
export default function LocaleNotFound() {
  const t = useTranslations('NotFound');
  const router = useRouter();

  useTelegramBackButton(useCallback(() => router.replace('/'), [router]));

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 p-6 text-center">
      <SearchX className="h-10 w-10 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-semibold">{t('title')}</h1>
      <p className="max-w-xs text-sm text-muted-foreground">{t('description')}</p>
      <Link href="/" replace className={cn(buttonVariants({ size: 'lg' }), 'w-full text-base')}>
        {t('homeAction')}
      </Link>
    </div>
  );
}
