'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import type { ImportRowError, ImportRowMessage } from '@/lib/api/imports';

/** Current-locale text of each message; uz is the fallback (legacy `messages` are uz too). */
function rowMessages(err: ImportRowError, locale: string): string[] {
  if (!err.i18n || err.i18n.length === 0) return err.messages;
  const key = (locale === 'ru' || locale === 'en' ? locale : 'uz') as keyof ImportRowMessage;
  return err.i18n.map((m) => m[key] || m.uz);
}

export function ImportErrorsTable({ errors }: { errors: ImportRowError[] }) {
  const t = useTranslations('Import');
  const locale = useLocale();

  if (errors.length === 0) return null;

  return (
    <div className="max-h-64 overflow-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('errorMessages')}</caption>
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">{t('row')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('errorMessages')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {errors.map((err) => (
            <tr key={err.row}>
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{err.row}</td>
              <td className="px-3 py-2 text-destructive"><AlertCircle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />{rowMessages(err, locale).join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
