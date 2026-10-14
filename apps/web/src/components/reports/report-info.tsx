'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { formatDateInZone } from '@/lib/format';

export type ReportNoteKey = 'amount' | 'avgCheck' | 'routeCompletion' | 'effectiveVisit' | 'debtSnapshot' | 'aging';

interface ReportInfoProps {
  /** Period as returned by the API; `asOf` (YYYY-MM-DD) is shown for point-in-time reports instead. */
  range?: { from: string; to: string };
  asOf?: string;
  timeZone: string;
  /** Whether the report is filtered by order status (sales/agents/overview). */
  statusFiltered?: boolean;
  notes: ReportNoteKey[];
}

/** Report definition block (TZ §3.4): period in company time zone, status filter, formulas. */
export function ReportInfo({ range, asOf, timeZone, statusFiltered, notes }: ReportInfoProps) {
  const t = useTranslations('Reports.info');
  const locale = useLocale();

  return (
    <section aria-label={t('title')} className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
      <p className="flex items-center gap-2 font-medium text-foreground">
        <Info className="h-4 w-4" aria-hidden="true" />
        {range
          ? t('period', { from: formatDateInZone(range.from, locale, timeZone), to: formatDateInZone(range.to, locale, timeZone), timeZone })
          : t('asOfDate', { asOf: asOf ?? '', timeZone })}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>{t('currency')}</li>
        {statusFiltered && <li>{t('statuses')}</li>}
        {notes.map((key) => (
          <li key={key}>{t(`notes.${key}`)}</li>
        ))}
      </ul>
    </section>
  );
}
