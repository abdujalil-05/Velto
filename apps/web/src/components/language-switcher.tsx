'use client';

import { useLocale, useTranslations } from 'next-intl';
import { routing } from '@/i18n/routing';
import { usePathname, useRouter } from '@/i18n/navigation';

const LOCALE_LABELS: Record<string, string> = {
  uz: "O'zbek",
  ru: 'Русский',
  en: 'English',
};

export function LanguageSwitcher() {
  const t = useTranslations('LanguageSwitcher');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="sr-only">{t('label')}</span>
      <select
        className="rounded-md border border-input bg-background px-2 py-1 text-sm"
        value={locale}
        onChange={(e) => {
          router.replace(pathname, { locale: e.target.value });
        }}
      >
        {routing.locales.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
