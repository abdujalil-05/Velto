'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { Route } from '@/lib/api/routes';
import { formatDate } from '@/lib/format';

/** Next calendar date (ISO weekday 1=Mon..7=Sun) on or after today matching the route's weekday. */
function nextDateForWeekday(weekday: number): Date {
  const now = new Date();
  const todayIso = now.getDay() === 0 ? 7 : now.getDay();
  const diff = (weekday - todayIso + 7) % 7;
  const result = new Date(now);
  result.setDate(now.getDate() + diff);
  return result;
}

export function RoutesTable({ routes }: { routes: Route[] }) {
  const t = useTranslations('Routes');
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('name')}</th>
            <th className="pb-2 pr-3 font-medium">{t('assignee')}</th>
            <th className="pb-2 pr-3 font-medium">{t('weekday')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('stopCount')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {routes.map((route) => (
            <tr key={route.id} className="hover:bg-accent/50">
              <td className="py-2 pr-3">
                <Link href={`/routes/${route.id}/edit`} className="font-medium text-primary hover:underline">
                  {route.name}
                </Link>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">
                {route.agent
                  ? `${route.agent.firstName} ${route.agent.lastName}`
                  : route.deliverySupplier
                    ? `${route.deliverySupplier.name} (${t('supplier')})`
                    : '—'}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">
                {t(`weekdays.${route.weekday}`)} · {formatDate(nextDateForWeekday(route.weekday), locale)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{route.stops.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
