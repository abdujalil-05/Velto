'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, RefreshCw } from 'lucide-react';
import {
  useSalesReportQuery,
  useAgentPerformanceReportQuery,
  useOverviewReportQuery,
  downloadSalesReportExcel,
  downloadAgentPerformanceExcel,
  downloadOverviewReportExcel,
} from '@/lib/api/reports';
import { useAgingReportQuery, downloadAgingReportExcel } from '@/lib/api/receivables';
import { errorMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { DateRangePicker } from '@/components/reports/date-range-picker';
import { SalesReportTab } from '@/components/reports/sales-report-tab';
import { AgentPerformanceTab } from '@/components/reports/agent-performance-tab';
import { OverviewTab } from '@/components/reports/overview-tab';
import { AgingReportTable } from '@/components/reports/aging-report-table';
import { cn } from '@/lib/utils';

type Tab = 'overview' | 'sales' | 'agents' | 'aging';
const TABS: Tab[] = ['overview', 'sales', 'agents', 'aging'];

export default function ReportsPage() {
  const t = useTranslations('Reports');
  const tCommon = useTranslations('Common');
  const locale = useLocale();

  const [tab, setTab] = useState<Tab>('overview');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = { from: from || undefined, to: to || undefined };

  const [agingPage, setAgingPage] = useState(1);
  const [isExporting, setIsExporting] = useState(false);

  const overviewQuery = useOverviewReportQuery(range, tab === 'overview');
  const salesQuery = useSalesReportQuery(range, tab === 'sales');
  const agentsQuery = useAgentPerformanceReportQuery(range, tab === 'agents');
  const agingQuery = useAgingReportQuery({ page: agingPage, pageSize: 25 });

  const activeQuery = tab === 'overview' ? overviewQuery : tab === 'sales' ? salesQuery : tab === 'agents' ? agentsQuery : agingQuery;

  async function handleExport() {
    setIsExporting(true);
    try {
      if (tab === 'aging') await downloadAgingReportExcel();
      else if (tab === 'sales') await downloadSalesReportExcel(range);
      else if (tab === 'agents') await downloadAgentPerformanceExcel(range);
      else await downloadOverviewReportExcel(range);
    } catch (err) {
      toast.error(errorMessage(err, locale));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={isExporting}>
          <Download className={cn('mr-2 h-4 w-4', isExporting && 'animate-pulse')} />
          {tCommon('export')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-border p-1">
          {TABS.map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              onClick={() => setTab(tabKey)}
              className={cn(
                'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                tab === tabKey ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t(`tabs.${tabKey}`)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {tab !== 'aging' && <DateRangePicker from={from} to={to} onFromChange={setFrom} onToChange={setTo} />}
          <Button variant="ghost" size="sm" onClick={() => activeQuery.refetch()} disabled={activeQuery.isFetching}>
            <RefreshCw className={cn('mr-2 h-4 w-4', activeQuery.isFetching && 'animate-spin')} />
            {t('refresh')}
          </Button>
        </div>
      </div>

      {activeQuery.isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      )}

      {activeQuery.isError && !activeQuery.isLoading && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(activeQuery.error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => activeQuery.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!activeQuery.isLoading && !activeQuery.isError && (
        <>
          {tab === 'overview' && overviewQuery.data && <OverviewTab report={overviewQuery.data} />}
          {tab === 'sales' && salesQuery.data && <SalesReportTab report={salesQuery.data} />}
          {tab === 'agents' && agentsQuery.data && <AgentPerformanceTab report={agentsQuery.data} />}
          {tab === 'aging' && agingQuery.data && (
            <Card>
              <CardContent className="pt-6">
                {agingQuery.data.data.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t('aging.emptyState')}</p>
                ) : (
                  <>
                    <AgingReportTable rows={agingQuery.data.data} />
                    <PaginationBar meta={agingQuery.data.meta} onPageChange={setAgingPage} />
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
