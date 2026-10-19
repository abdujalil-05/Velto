'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertCircle, CheckCircle2, FileSpreadsheet, Info, Loader2, TriangleAlert, Upload } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/api/client';
import { usePreviewOpeningMutation, type OpeningBatch, type OpeningKind, type OpeningReportSummary } from '@/lib/api/opening-balances';
import { formatMoney, formatQty } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ImportErrorsTable } from '@/components/import/import-errors-table';
import { PostOpeningForm } from './post-opening-form';
import { OpeningHistory } from './opening-history';
import { OpeningTemplateDownload } from './template-download';

const KINDS: OpeningKind[] = ['CUSTOMER_BALANCE', 'STOCK'];

/** Opening balances (ADR-041..043): upload -> preview -> 1C control totals + sign-off -> post; batch history with void. */
export function OpeningBalancesPanel({ showHistory = true }: { showHistory?: boolean }) {
  const t = useTranslations('OpeningBalances');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('opening.read');
  const canPreview = hasPermission('opening.preview');
  const canPost = hasPermission('opening.post');
  const canVoid = hasPermission('opening.void');

  const [kind, setKind] = useState<OpeningKind>('CUSTOMER_BALANCE');
  const [report, setReport] = useState<OpeningReportSummary | null>(null);
  const [posted, setPosted] = useState<OpeningBatch | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = usePreviewOpeningMutation(kind);

  if (!canRead) {
    return (
      <Alert>
        <AlertDescription>{t('noPermission')}</AlertDescription>
      </Alert>
    );
  }

  function reset() {
    setReport(null);
    setPosted(null);
    preview.reset();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPosted(null);
    preview.mutate(file, {
      onSuccess: setReport,
      onError: (err) => toast.error(errorMessage(err, locale)),
    });
  }

  const isStock = report?.batch.kind === 'STOCK';

  return (
    <div className="space-y-4">
      {!canPreview && !posted && (
        <Alert>
          <Info className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{t('uploadOwnerOnly')}</AlertDescription>
        </Alert>
      )}

      {canPreview && !report && !posted && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
            <div className="flex gap-1 rounded-md border border-border p-1" role="tablist">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={kind === k}
                  onClick={() => {
                    setKind(k);
                    preview.reset();
                  }}
                  className={cn(
                    'min-h-10 rounded px-3 py-1.5 text-sm font-medium transition-colors',
                    kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {t(`kinds.${k}`)}
                </button>
              ))}
            </div>

            <Alert>
              <Info className="h-4 w-4" aria-hidden="true" />
              <AlertDescription className="space-y-1">
                <p className="font-medium">{t('guide.title')}</p>
                <p>{t(`guide.${kind}`)}</p>
                <p>{t('guide.formats')}</p>
              </AlertDescription>
            </Alert>

            {preview.isError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription className="flex items-center justify-between gap-4">
                  <span>{errorMessage(preview.error, locale)}</span>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <OpeningTemplateDownload kind={kind} />
              <Button onClick={() => fileInput.current?.click()} disabled={preview.isPending}>
                {preview.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {preview.isError ? t('uploadRetry') : t('upload')}
              </Button>
              <input ref={fileInput} type="file" accept=".xlsx,.csv" className="hidden" onChange={onFile} />
            </div>
          </CardContent>
        </Card>
      )}

      {canPreview && report && !posted && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">{t(`kinds.${report.batch.kind}`)}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={reset}>
                {t('startOver')}
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-3">
              <Stat label={t('preview.totalRows')} value={String(report.totalRows)} />
              <Stat label={t('preview.validRows')} value={String(report.validCount)} tone="success" />
              <Stat label={t('preview.invalidRows')} value={String(report.invalidCount)} tone={report.invalidCount ? 'destructive' : undefined} />
              {isStock ? (
                <Stat label={t('preview.totalQty')} value={formatQty(report.batch.qtyTotal)} />
              ) : (
                <>
                  <Stat label={t('preview.totalDebt')} value={`${formatMoney(report.batch.debtTotal)} ${tCommon('somUnit')}`} />
                  <Stat label={t('preview.totalCredit')} value={`${formatMoney(report.batch.creditTotal)} ${tCommon('somUnit')}`} />
                </>
              )}
            </div>

            {report.warnings.map((w) => (
              <Alert key={w.code} variant="warning">
                <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{w.message[locale as 'uz' | 'ru' | 'en'] || w.message.uz}</AlertDescription>
              </Alert>
            ))}

            {report.errors.length > 0 && <ImportErrorsTable errors={report.errors} />}

            {report.invalidCount > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{t('preview.hasErrors')}</AlertDescription>
              </Alert>
            )}

            {report.invalidCount === 0 && !canPost && (
              <Alert>
                <Info className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{t('preview.ownerOnly')}</AlertDescription>
              </Alert>
            )}

            {report.invalidCount === 0 && canPost && (
              <PostOpeningForm
                batch={report.batch}
                onPosted={(b) => {
                  setPosted(b);
                  setReport(null);
                  toast.success(t('post.success'));
                }}
              />
            )}
          </CardContent>
        </Card>
      )}

      {posted && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <Alert variant="success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>
                {t('post.result', { rows: posted.rowCount, kind: t(`kinds.${posted.kind}`) })}{' '}
                {posted.kind === 'STOCK'
                  ? formatQty(posted.qtyTotal)
                  : `${formatMoney(posted.debtTotal)} / ${formatMoney(posted.creditTotal)} ${tCommon('somUnit')}`}
              </AlertDescription>
            </Alert>
            <div className="flex justify-end">
              <Button variant="outline" onClick={reset}>
                {t('newUpload')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {showHistory && <OpeningHistory canVoid={canVoid} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'destructive' }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className={cn('text-xl font-semibold tabular-nums', tone === 'success' && 'text-success', tone === 'destructive' && 'text-destructive')}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
