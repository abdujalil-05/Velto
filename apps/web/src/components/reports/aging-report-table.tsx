'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AgingRow } from '@/lib/api/receivables';

export function AgingReportTable({ rows }: { rows: AgingRow[] }) {
  const t = useTranslations('Receivables');
  const tCommon = useTranslations('Common');

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('customer')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('current')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('d1to30')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('d31to60')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('d61to90')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('d90plus')}</th>
            <th className="pb-2 text-right font-medium">{t('total')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.customerId} className="hover:bg-accent/50">
              <td className="py-2 pr-3">
                <Link href={`/customers/${row.customerId}`} className="font-medium text-primary hover:underline">
                  {row.customerName}
                </Link>
              </td>
              <Cell value={row.buckets.current} />
              <Cell value={row.buckets.d1to30} />
              <Cell value={row.buckets.d31to60} />
              <Cell value={row.buckets.d61to90} severe />
              <Cell value={row.buckets.d90plus} severe />
              <td className="py-2 text-right font-semibold tabular-nums">
                {formatMoney(row.total)} <span className="text-muted-foreground">{tCommon('somUnit')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ value, severe }: { value: string; severe?: boolean }) {
  const isZero = Number(value) === 0;
  return (
    <td
      className={cn(
        'py-2 pr-3 text-right tabular-nums',
        isZero ? 'text-muted-foreground' : severe ? 'font-medium text-destructive' : 'text-foreground',
      )}
    >
      {isZero ? '—' : formatMoney(value)}
    </td>
  );
}
