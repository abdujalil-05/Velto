'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { GpsStatus, Visit } from '@/lib/api/visits';
import { formatDateTime, formatQty } from '@/lib/format';

const GPS_VARIANT: Record<GpsStatus, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  VERIFIED: 'success',
  OUTSIDE_RADIUS: 'destructive',
  LOW_ACCURACY: 'warning',
  NO_PERMISSION: 'secondary',
  NO_FIX: 'secondary',
  OUTLET_NO_COORDS: 'warning',
};

export function VisitsTable({ visits }: { visits: Visit[] }) {
  const t = useTranslations('Visits');
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('startedAt')}</th>
            <th className="pb-2 pr-3 font-medium">{t('agent')}</th>
            <th className="pb-2 pr-3 font-medium">{t('outlet')}</th>
            <th className="pb-2 pr-3 font-medium">{t('outcome')}</th>
            <th className="pb-2 pr-3 font-medium">{t('gpsStatus')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('distanceM')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('accuracyM')}</th>
            <th className="pb-2 pr-3 font-medium">{t('reason')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {visits.map((v) => (
            <tr key={v.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(v.startedAt, locale)}</td>
              <td className="py-2 pr-3">
                {v.agent.firstName} {v.agent.lastName}
              </td>
              <td className="py-2 pr-3 font-medium">{v.outlet.name}</td>
              <td className="py-2 pr-3">
                <Badge variant={v.outcome === 'ORDERED' ? 'success' : v.outcome === 'SKIPPED' ? 'warning' : 'secondary'}>
                  {t(`outcomes.${v.outcome}`)}
                </Badge>
              </td>
              <td className="py-2 pr-3">
                <Badge variant={GPS_VARIANT[v.gpsStatus]}>{t(`gps.${v.gpsStatus}`)}</Badge>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{v.distanceM !== null ? formatQty(v.distanceM) : '—'}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{v.gpsAccuracyM !== null ? formatQty(v.gpsAccuracyM) : '—'}</td>
              <td className="py-2 pr-3 text-muted-foreground">{v.skipReason ?? v.noOrderReason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
