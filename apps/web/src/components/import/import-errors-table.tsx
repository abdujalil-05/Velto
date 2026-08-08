'use client';

import { useTranslations } from 'next-intl';
import type { ImportRowError } from '@/lib/api/imports';

export function ImportErrorsTable({ errors }: { errors: ImportRowError[] }) {
  const t = useTranslations('Import');

  if (errors.length === 0) return null;

  return (
    <div className="max-h-64 overflow-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t('row')}</th>
            <th className="px-3 py-2 font-medium">{t('errorMessages')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {errors.map((err) => (
            <tr key={err.row}>
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{err.row}</td>
              <td className="px-3 py-2 text-destructive">{err.messages.join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
