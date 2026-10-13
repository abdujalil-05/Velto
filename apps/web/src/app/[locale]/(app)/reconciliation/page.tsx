'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Lock, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth/auth-context';
import { ApiError, errorMessage } from '@/lib/api/client';
import {
  useFixFindingMutation,
  useReconciliationFindingsQuery,
  useReconciliationRunsQuery,
  useRunReconciliationMutation,
  type ReconciliationFinding,
  type ReconciliationFindingStatus,
  type ReconciliationKind,
} from '@/lib/api/reconciliation';
import { formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { cn } from '@/lib/utils';

function Triple({ expected, actual, diff, qty }: { expected: string | null; actual: string | null; diff: string | null; qty: boolean }) {
  const fmt = qty ? formatQty : formatMoney;
  return (
    <span className="whitespace-nowrap">
      {expected === null ? '—' : fmt(expected)} / {actual === null ? '—' : fmt(actual)} /{' '}
      <span className="font-medium text-destructive">{diff === null ? '—' : fmt(diff)}</span>
    </span>
  );
}

export default function ReconciliationPage() {
  const t = useTranslations('Reconciliation');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('reconciliation.read');
  const canFix = hasPermission('reconciliation.fix');

  const [kind, setKind] = useState<ReconciliationKind | ''>('');
  const [status, setStatus] = useState<ReconciliationFindingStatus | ''>('OPEN');
  const [page, setPage] = useState(1);
  const [runsPage, setRunsPage] = useState(1);
  const [fixTarget, setFixTarget] = useState<ReconciliationFinding | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const runKey = useRef<string | null>(null);
  const fixKey = useRef<{ id: string; key: string } | null>(null);

  const findings = useReconciliationFindingsQuery({
    page,
    pageSize: 25,
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
  });
  const runs = useReconciliationRunsQuery({ page: runsPage, pageSize: 5 });
  const runMutation = useRunReconciliationMutation();
  const fixMutation = useFixFindingMutation();

  if (!canRead) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center gap-2">
          <Lock className="h-4 w-4" />
          {t('noPermission')}
        </AlertDescription>
      </Alert>
    );
  }

  function busyAware(err: unknown): string {
    if (err instanceof ApiError && err.code === 'RECONCILIATION_BUSY') return t('busy');
    return errorMessage(err, locale);
  }

  function handleRun() {
    setRunError(null);
    runMutation.mutate(
      { idempotencyKey: (runKey.current ??= crypto.randomUUID()) },
      {
        onSuccess: (r) => {
          runKey.current = null;
          toast.success(t('runDone', { stock: r.stockFindings, balance: r.balanceFindings, healed: r.selfHealed }));
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status < 500) runKey.current = null;
          setRunError(busyAware(err));
        },
      },
    );
  }

  function handleFix() {
    if (!fixTarget) return;
    const target = fixTarget;
    if (fixKey.current?.id !== target.id) fixKey.current = { id: target.id, key: crypto.randomUUID() };
    setFixError(null);
    fixMutation.mutate(
      { id: target.id, idempotencyKey: fixKey.current.key },
      {
        onSuccess: (r) => {
          fixKey.current = null;
          setFixTarget(null);
          if (r.outcome === 'ALREADY_CONSISTENT') toast.info(t('alreadyConsistent'));
          else toast.success(t('fixed'));
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status < 500) fixKey.current = null;
          setFixError(busyAware(err));
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              findings.refetch();
              runs.refetch();
            }}
            disabled={findings.isFetching}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', findings.isFetching && 'animate-spin')} />
            {t('refresh')}
          </Button>
          {canFix && (
            <Button onClick={handleRun} disabled={runMutation.isPending}>
              {runMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {t('runNow')}
            </Button>
          )}
        </div>
      </div>

      {runError && (
        <Alert variant="destructive">
          <AlertDescription>{runError}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          <span className="mr-2 text-muted-foreground">{t('filters.kind')}</span>
          <Select
            className="inline-block w-auto"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ReconciliationKind | '');
              setPage(1);
            }}
          >
            <option value="">{t('filters.all')}</option>
            <option value="STOCK">{t('kind.STOCK')}</option>
            <option value="BALANCE">{t('kind.BALANCE')}</option>
          </Select>
        </label>
        <label className="text-sm">
          <span className="mr-2 text-muted-foreground">{t('filters.status')}</span>
          <Select
            className="inline-block w-auto"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ReconciliationFindingStatus | '');
              setPage(1);
            }}
          >
            <option value="">{t('filters.all')}</option>
            <option value="OPEN">{t('status.OPEN')}</option>
            <option value="FIXED">{t('status.FIXED')}</option>
          </Select>
        </label>
      </div>

      {findings.isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      )}

      {findings.isError && !findings.isLoading && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(findings.error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => findings.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {findings.data && findings.data.data.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <ShieldCheck className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      )}

      {findings.data && findings.data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="mb-2 text-xs text-muted-foreground">{t('columnsHint')}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('col.kind')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.subject')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.main')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.reserved')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.status')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.detected')}</th>
                    {canFix && <th className="pb-2 font-medium" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {findings.data.data.map((f) => (
                    <tr key={f.id}>
                      <td className="py-2 pr-3">{t(`kind.${f.kind}`)}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {f.kind === 'STOCK' ? (
                          <>
                            {t('product')}: {f.productId}
                            <br />
                            {t('warehouse')}: {f.warehouseId}
                          </>
                        ) : (
                          <>
                            {t('customer')}: {f.customerId}
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {f.kind === 'STOCK' ? (
                          <Triple expected={f.expectedOnHand} actual={f.actualOnHand} diff={f.diffOnHand} qty />
                        ) : (
                          <Triple expected={f.expectedBalance} actual={f.actualBalance} diff={f.diffBalance} qty={false} />
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {f.kind === 'STOCK' ? (
                          <Triple expected={f.expectedReserved} actual={f.actualReserved} diff={f.diffReserved} qty />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={f.status === 'OPEN' ? 'destructive' : 'success'}>{t(`status.${f.status}`)}</Badge>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{formatDateTime(f.createdAt, locale)}</td>
                      {canFix && (
                        <td className="py-2 text-right">
                          {f.status === 'OPEN' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setFixError(null);
                                setFixTarget(f);
                              }}
                            >
                              {t('fix')}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar meta={findings.data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <h2 className="pt-2 text-lg font-semibold">{t('runsTitle')}</h2>
      {runs.isLoading && <Skeleton className="h-24 w-full" />}
      {runs.isError && !runs.isLoading && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMessage(runs.error, locale)}</span>
            <Button variant="outline" size="sm" onClick={() => runs.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {runs.data && runs.data.data.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">{t('runsEmpty')}</CardContent>
        </Card>
      )}
      {runs.data && runs.data.data.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('runs.started')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('runs.trigger')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('runs.stock')}</th>
                    <th className="pb-2 font-medium">{t('runs.balance')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.data.data.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(r.startedAt, locale)}</td>
                      <td className="py-2 pr-3">{t(`trigger.${r.trigger}`)}</td>
                      <td className="py-2 pr-3">{t('runs.ratio', { found: r.stockFindings, checked: r.stockChecked })}</td>
                      <td className="py-2">{t('runs.ratio', { found: r.balanceFindings, checked: r.balanceChecked })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar meta={runs.data.meta} onPageChange={setRunsPage} />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={fixTarget !== null}
        onOpenChange={(o) => !o && setFixTarget(null)}
        title={t('fixDialog.title')}
        description={t('fixDialog.description')}
        confirmLabel={t('fixDialog.confirm')}
        cancelLabel={tc('confirmDelete.cancel')}
        error={fixError}
        isPending={fixMutation.isPending}
        onConfirm={handleFix}
      />
    </div>
  );
}
