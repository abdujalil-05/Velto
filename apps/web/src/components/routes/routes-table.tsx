'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { Route } from '@/lib/api/routes';

export function RoutesTable({ routes }: { routes: Route[] }) {
  const t = useTranslations('Routes');

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{t('name')}</th>
            <th className="pb-2 pr-3 font-medium">{t('agent')}</th>
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
                {route.agent.firstName} {route.agent.lastName}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{t(`weekdays.${route.weekday}`)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{route.stops.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
