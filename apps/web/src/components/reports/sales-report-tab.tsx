'use client';

import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TurnoverChart } from '@/components/dashboard/turnover-chart';
import { SimpleStat } from './simple-stat';
import type { SalesReport } from '@/lib/api/reports';

export function SalesReportTab({ report }: { report: SalesReport }) {
  const t = useTranslations('Reports.sales');
  const tCommon = useTranslations('Common');
  const unit = tCommon('somUnit');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SimpleStat label={t('turnover')} value={formatMoney(report.summary.turnover)} unit={unit} />
        <SimpleStat label={t('orderCount')} value={String(report.summary.orderCount)} />
        <SimpleStat label={t('avgCheck')} value={formatMoney(report.summary.avgCheck)} unit={unit} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('byDay')}</CardTitle>
        </CardHeader>
        <CardContent>
          {report.byDay.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('noData')}</p>
          ) : (
            <TurnoverChart data={report.byDay} />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('byAgent')}</CardTitle>
          </CardHeader>
          <CardContent>
            {report.byAgent.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noData')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {report.byAgent.map((row) => (
                  <li key={row.agentId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="font-medium">{row.agentName}</span>
                    <span className="tabular-nums">
                      {formatMoney(row.turnover)} {unit}
                      <span className="ml-2 text-muted-foreground">({row.orderCount})</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('topProducts')}</CardTitle>
          </CardHeader>
          <CardContent>
            {report.topProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noData')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {report.topProducts.map((row) => (
                  <li key={row.productId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="font-medium">{row.productName}</span>
                    <span className="tabular-nums">
                      {formatMoney(row.turnover)} {unit}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
