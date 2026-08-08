'use client';

import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/format';
import { SimpleStat } from './simple-stat';
import type { OverviewReport } from '@/lib/api/reports';

export function OverviewTab({ report }: { report: OverviewReport }) {
  const t = useTranslations('Reports.overview');
  const tCommon = useTranslations('Common');
  const unit = tCommon('somUnit');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SimpleStat label={t('turnover')} value={formatMoney(report.turnover)} unit={unit} />
        <SimpleStat label={t('orderCount')} value={String(report.orderCount)} />
        <SimpleStat label={t('avgCheck')} value={formatMoney(report.avgCheck)} unit={unit} />
        <SimpleStat label={t('activeCustomers')} value={String(report.activeCustomers)} />
        <SimpleStat label={t('newCustomers')} value={String(report.newCustomers)} />
        <SimpleStat label={t('totalCustomers')} value={String(report.totalCustomers)} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SimpleStat label={t('totalDebt')} value={formatMoney(report.totalDebt)} unit={unit} />
        <SimpleStat label={t('overdueDebt')} value={formatMoney(report.overdueDebt)} unit={unit} />
        <SimpleStat label={t('overdueDebtPct')} value={report.overdueDebtPct === null ? '—' : `${report.overdueDebtPct.toFixed(1)}%`} />
      </div>
    </div>
  );
}
