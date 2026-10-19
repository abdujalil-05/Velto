'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Undo2 } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { useOpeningBatchesQuery, type OpeningBatch, type OpeningStatus } from '@/lib/api/opening-balances';
import { formatDate, formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { VoidOpeningDialog } from './void-opening-dialog';

const STATUS_VARIANT = { PREVIEWED: 'warning', POSTED: 'success', VOIDED: 'destructive' } as const satisfies Record<OpeningStatus, string>;

export function OpeningHistory({ canVoid }: { canVoid: boolean }) {
  const t = useTranslations('OpeningBalances');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const [voidTarget, setVoidTarget] = useState<OpeningBatch | null>(null);
  const { data, isLoading, isError, error, refetch } = useOpeningBatchesQuery({ page, pageSize: 10 });

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">{t('history.title')}</h2>
      {isLoading && <Skeleton className="h-24 w-full" />}
      {isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {data && data.data.length === 0 && <p className="text-sm text-muted-foreground">{t('history.empty')}</p>}
      {data && data.data.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">{t('history.kind')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('history.createdAt')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('history.source')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('history.rows')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('history.totals')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('history.status')}</th>
                  {canVoid && <th className="pb-2 text-right font-medium">{t('history.actions')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.data.map((b) => (
                  <tr key={b.id}>
                    <td className="py-2 pr-3">{t(`kinds.${b.kind}`)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{formatDateTime(b.createdAt, locale)}</td>
                    <td className="py-2 pr-3">
                      <p>{b.source}</p>
                      {b.status !== 'PREVIEWED' && <p className="text-xs text-muted-foreground">{t('history.asOf')}: {formatDate(b.asOfDate, locale)}</p>}
                      {b.status === 'VOIDED' && b.voidReason && <p className="text-xs text-muted-foreground">{b.voidReason}</p>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{b.rowCount}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {b.kind === 'STOCK' ? (
                        formatQty(b.qtyTotal)
                      ) : (
                        <>
                          <p>{t('history.debt')}: {formatMoney(b.debtTotal)} {tCommon('somUnit')}</p>
                          <p>{t('history.credit')}: {formatMoney(b.creditTotal)} {tCommon('somUnit')}</p>
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={STATUS_VARIANT[b.status]}>{t(`statuses.${b.status}`)}</Badge>
                    </td>
                    {canVoid && (
                      <td className="py-2 text-right">
                        {b.status === 'POSTED' && (
                          <Button variant="ghost" size="sm" onClick={() => setVoidTarget(b)}>
                            <Undo2 className="mr-1 h-4 w-4" />
                            {t('void.action')}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar meta={data.meta} onPageChange={setPage} />
        </>
      )}
      <VoidOpeningDialog batch={voidTarget} onClose={() => setVoidTarget(null)} />
    </section>
  );
}
