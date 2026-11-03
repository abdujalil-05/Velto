'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Check, Download, FileOutput, Info, Loader2, XCircle } from 'lucide-react';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useCompanyExportsQuery, useCreateCompanyExportMutation, useDownloadCompanyExportMutation } from '@/lib/api/company-export';
import { ACTIVE_EXPORT_STATUSES, DOWNLOADABLE_EXPORT_STATUSES, type ExportJob, type ExportJobStatus } from '@/lib/api/export-1c';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_VARIANT: Partial<Record<ExportJobStatus, BadgeProps['variant']>> = { QUEUED: 'secondary', PROCESSING: 'warning', GENERATED: 'success', FAILED: 'destructive' };

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Full company data export (ADR-045): OWNER-only, for the customer's data-access right and offboarding. */
export function CompanyExportCard() {
  const t = useTranslations('CompanyExport');
  const locale = useLocale();
  const jobs = useCompanyExportsQuery({ page: 1, pageSize: 10 });
  const createMutation = useCreateCompanyExportMutation();
  const downloadMutation = useDownloadCompanyExportMutation();
  const [createError, setCreateError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [hashChecks, setHashChecks] = useState<Record<string, 'match' | 'mismatch' | 'unavailable'>>({});
  const createKey = useRef<string | null>(null);

  const rows = jobs.data?.data ?? [];
  const hasActive = rows.some((j) => ACTIVE_EXPORT_STATUSES.includes(j.status));

  function apiMessage(err: unknown): string {
    if (err instanceof ApiError && err.status === 429) return t('throttled');
    return errorMessage(err, locale);
  }

  function handleCreate() {
    setCreateError(null);
    createMutation.mutate((createKey.current ??= crypto.randomUUID()), {
      onSuccess: () => {
        createKey.current = null;
        toast.success(t('created'));
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status < 500) createKey.current = null;
        setCreateError(apiMessage(err));
      },
    });
  }

  function handleDownload(job: ExportJob) {
    setDownloadingId(job.id);
    downloadMutation.mutate(job, {
      onSuccess: ({ sha256 }) => {
        const check = !sha256 || !job.fileHash ? 'unavailable' : sha256.toLowerCase() === job.fileHash.toLowerCase() ? 'match' : 'mismatch';
        setHashChecks((prev) => ({ ...prev, [job.id]: check }));
        if (check === 'mismatch') toast.error(t('hash.mismatch'));
      },
      onError: (err) => toast.error(apiMessage(err)),
      onSettled: () => setDownloadingId(null),
    });
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('purpose')}</p>
        </div>

        <Alert>
          <Info className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="space-y-1">
            <p>{t('includes')}</p>
            <p>{t('excludes')}</p>
          </AlertDescription>
        </Alert>

        <div className="flex justify-end">
          <Button className="min-h-12" onClick={handleCreate} disabled={createMutation.isPending || hasActive}>
            {createMutation.isPending || hasActive ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileOutput className="mr-2 h-4 w-4" />}
            {hasActive ? t('inProgress') : t('create')}
          </Button>
        </div>

        {createError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}

        {jobs.isLoading && <Skeleton className="h-24 w-full" />}

        {jobs.isError && !jobs.isLoading && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{errorMessage(jobs.error, locale)}</span>
              <Button variant="outline" size="sm" onClick={() => jobs.refetch()}>
                {t('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {jobs.data && rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">{t('col.status')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('col.file')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('col.size')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('col.date')}</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {rows.map((job) => {
                  const check = hashChecks[job.id];
                  return (
                    <tr key={job.id}>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS_VARIANT[job.status] ?? 'secondary'}>{t(`status.${job.status}`)}</Badge>
                        {job.status === 'FAILED' && (
                          <p className="mt-1 flex max-w-xs items-start gap-1 text-xs text-destructive">
                            <XCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="break-words">{job.errorLog?.message ?? t('failedUnknown')}</span>
                          </p>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="break-all">{job.fileName ?? '—'}</div>
                        {check && (
                          <p className={`mt-1 flex items-center gap-1 text-xs ${check === 'match' ? 'text-success' : check === 'mismatch' ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {check === 'match' ? <Check className="h-3 w-3" aria-hidden="true" /> : <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
                            {t(`hash.${check}`)}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">{formatSize(job.fileSize)}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{formatDateTime(job.generatedAt ?? job.createdAt, locale)}</td>
                      <td className="py-2 text-right">
                        {DOWNLOADABLE_EXPORT_STATUSES.includes(job.status) && (
                          <Button variant="outline" size="sm" className="min-h-12" onClick={() => handleDownload(job)} disabled={downloadingId === job.id}>
                            {downloadingId === job.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                            {t('download')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
