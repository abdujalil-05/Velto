'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, XCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useImportJobsQuery,
  useImportJobQuery,
  useUploadImportMutation,
  useConfirmImportMutation,
  downloadImportTemplate,
  type ImportType,
} from '@/lib/api/imports';
import { errorMessage } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ImportStatusBadge } from '@/components/import/import-status-badge';
import { ImportErrorsTable } from '@/components/import/import-errors-table';
import { cn } from '@/lib/utils';

const TYPES: ImportType[] = ['customers', 'products'];

export default function ImportPage() {
  const t = useTranslations('Import');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canUpload = hasPermission('settings.update');
  const queryClient = useQueryClient();

  const [type, setType] = useState<ImportType>('customers');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useUploadImportMutation(type);
  const confirmMutation = useConfirmImportMutation();
  const { data: activeJob, isLoading: activeJobLoading } = useImportJobQuery(activeJobId, true);
  const { data: history, isLoading: historyLoading, refetch: refetchHistory } = useImportJobsQuery({ page: 1, pageSize: 10 });

  async function handleDownloadTemplate() {
    setIsDownloadingTemplate(true);
    try {
      await downloadImportTemplate(type);
    } catch (err) {
      toast.error(errorMessage(err, locale));
    } finally {
      setIsDownloadingTemplate(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadMutation.mutate(file, {
      onSuccess: (job) => {
        queryClient.setQueryData(['imports', job.id], job);
        setActiveJobId(job.id);
      },
      onError: (err) => toast.error(errorMessage(err, locale)),
    });
    e.target.value = '';
  }

  function handleConfirm() {
    if (!activeJobId) return;
    confirmMutation.mutate(activeJobId, {
      onError: (err) => toast.error(errorMessage(err, locale)),
    });
  }

  function startOver() {
    setActiveJobId(null);
    refetchHistory();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>

      {!activeJobId && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex gap-1 rounded-md border border-border p-1">
              {TYPES.map((typeKey) => (
                <button
                  key={typeKey}
                  type="button"
                  onClick={() => setType(typeKey)}
                  className={cn(
                    'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                    type === typeKey ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {t(`types.${typeKey}`)}
                </button>
              ))}
            </div>

            <ol className="space-y-3 text-sm">
              <li className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <span>{t('step1')}</span>
                <Button variant="outline" size="sm" onClick={handleDownloadTemplate} disabled={isDownloadingTemplate}>
                  <Download className="mr-2 h-4 w-4" />
                  {t('downloadTemplate')}
                </Button>
              </li>
              <li className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <span>{t('step2')}</span>
                <Button
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!canUpload || uploadMutation.isPending}
                >
                  {uploadMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  {t('uploadFile')}
                </Button>
                <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileChange} />
              </li>
            </ol>

            {!canUpload && (
              <Alert>
                <AlertDescription>{t('noPermission')}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {activeJobId && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            {activeJobLoading && <Skeleton className="h-32 w-full" />}

            {activeJob && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
                    <span className="font-medium">{t(`types.${activeJob.type}`)}</span>
                    <ImportStatusBadge status={activeJob.status} />
                  </div>
                  <Button variant="ghost" size="sm" onClick={startOver}>
                    {t('startOver')}
                  </Button>
                </div>

                {activeJob.errorLog && (
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <Stat label={t('totalRows')} value={activeJob.errorLog.totalRows} />
                    <Stat
                      label={activeJob.status === 'DONE' ? t('created') : t('validRows')}
                      value={activeJob.status === 'DONE' ? (activeJob.errorLog.createdCount ?? 0) : activeJob.errorLog.validCount}
                      tone="success"
                    />
                    <Stat
                      label={activeJob.status === 'DONE' ? t('skipped') : t('invalidRows')}
                      value={activeJob.status === 'DONE' ? (activeJob.errorLog.skippedCount ?? 0) : activeJob.errorLog.invalidCount}
                      tone={
                        (activeJob.status === 'DONE' ? activeJob.errorLog.skippedCount : activeJob.errorLog.invalidCount) ? 'destructive' : undefined
                      }
                    />
                  </div>
                )}

                {activeJob.status === 'PROCESSING' && (
                  <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('processing')}
                  </div>
                )}

                {activeJob.status === 'FAILED' && (
                  <Alert variant="destructive">
                    <XCircle className="h-4 w-4" />
                    <AlertDescription>{activeJob.errorLog?.message ?? t('failedGeneric')}</AlertDescription>
                  </Alert>
                )}

                {activeJob.status === 'DONE' && (
                  <Alert>
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertDescription>{t('doneMessage')}</AlertDescription>
                  </Alert>
                )}

                {activeJob.errorLog && activeJob.errorLog.errors.length > 0 && <ImportErrorsTable errors={activeJob.errorLog.errors} />}

                {activeJob.status === 'PENDING' && (
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={startOver}>
                      {t('cancel')}
                    </Button>
                    <Button onClick={handleConfirm} disabled={!canUpload || confirmMutation.isPending}>
                      {confirmMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('confirmImport')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{t('history')}</h2>
        <Card>
          <CardContent className="pt-6">
            {historyLoading && (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            )}
            {history && history.data.length === 0 && <p className="text-sm text-muted-foreground">{t('noHistory')}</p>}
            {history && history.data.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">{t('type')}</th>
                      <th className="pb-2 pr-3 font-medium">{t('date')}</th>
                      <th className="pb-2 pr-3 font-medium">{t('status')}</th>
                      <th className="pb-2 text-right font-medium">{t('actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {history.data.map((job) => (
                      <tr key={job.id} className="hover:bg-accent/50">
                        <td className="py-2 pr-3">{t(`types.${job.type}`)}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{formatDateTime(job.createdAt, locale)}</td>
                        <td className="py-2 pr-3">
                          <ImportStatusBadge status={job.status} />
                        </td>
                        <td className="py-2 text-right">
                          <Button variant="ghost" size="sm" onClick={() => setActiveJobId(job.id)}>
                            {t('view')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'destructive' }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className={cn('text-2xl font-semibold', tone === 'success' && 'text-success', tone === 'destructive' && 'text-destructive')}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
