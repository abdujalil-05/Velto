'use client';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Check, CheckCircle2, Copy, Download, FileOutput, Loader2, Lock, RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth/auth-context';
import { ApiError, errorMessage } from '@/lib/api/client';
import {
  DOWNLOADABLE_EXPORT_STATUSES,
  useAckExportMutation,
  useCreateExportMutation,
  useDownloadExportMutation,
  useExportJobsQuery,
  type ExportFormat,
  type ExportJob,
  type ExportJobStatus,
} from '@/lib/api/export-1c';
import { useSettingsQuery } from '@/lib/api/settings';
import { formatDateInZone, formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { PaginationBar } from '@/components/shared/pagination-bar';
import { ReverseDialog } from '@/components/shared/reverse-dialog';

const DEFAULT_TZ = 'Asia/Tashkent';
const FORMATS: ExportFormat[] = ['EXCEL', 'CSV', 'XML'];
const STATUS_VARIANT: Record<ExportJobStatus, BadgeProps['variant']> = {
  QUEUED: 'secondary',
  PROCESSING: 'warning',
  GENERATED: 'default',
  FAILED: 'destructive',
  ACCOUNTING_ACCEPTED: 'success',
  FAILED_REVIEW: 'destructive',
};

/** Calendar date (YYYY-MM-DD) of yesterday in the company time zone — the latest allowed period end. */
function yesterdayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 86_400_000));
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

type HashCheck = 'match' | 'mismatch' | 'unavailable';

export default function Export1cPage() {
  const t = useTranslations('Export1c');
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const canExport = hasPermission('integrations.export1c');
  const canAck = hasPermission('integrations.ack1c');

  const settings = useSettingsQuery(hasPermission('settings.read'));
  const tz = settings.data?.timezone ?? DEFAULT_TZ;
  const maxDate = useMemo(() => yesterdayIn(tz), [tz]);

  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [format, setFormat] = useState<ExportFormat>('EXCEL');
  const [createError, setCreateError] = useState<string | null>(null);
  const [ackTarget, setAckTarget] = useState<{ job: ExportJob; result: 'ACCEPTED' | 'REJECTED' } | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [hashChecks, setHashChecks] = useState<Record<string, HashCheck>>({});
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const createKey = useRef<string | null>(null);
  const ackKey = useRef<string | null>(null);

  const jobs = useExportJobsQuery({ page, pageSize: 20 });
  const createMutation = useCreateExportMutation();
  const ackMutation = useAckExportMutation();
  const downloadMutation = useDownloadExportMutation();

  if (!canExport) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center gap-2">
          <Lock className="h-4 w-4" />
          {t('noPermission')}
        </AlertDescription>
      </Alert>
    );
  }

  function apiMessage(err: unknown): string {
    if (err instanceof ApiError && err.status === 429 && err.code !== 'EXPORT_ACTIVE_LIMIT') return t('throttled');
    return errorMessage(err, locale);
  }

  const periodInvalid = !from || !to || from > to || to > maxDate;

  function handleCreate() {
    if (periodInvalid) return;
    setCreateError(null);
    createMutation.mutate(
      { from, to, format, idempotencyKey: (createKey.current ??= crypto.randomUUID()) },
      {
        onSuccess: () => {
          createKey.current = null;
          toast.success(t('created'));
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status < 500) createKey.current = null;
          setCreateError(apiMessage(err));
        },
      },
    );
  }

  function handleDownload(job: ExportJob) {
    setDownloadingId(job.id);
    downloadMutation.mutate(job, {
      onSuccess: ({ sha256 }) => {
        const check: HashCheck = !sha256 || !job.fileHash ? 'unavailable' : sha256.toLowerCase() === job.fileHash.toLowerCase() ? 'match' : 'mismatch';
        setHashChecks((prev) => ({ ...prev, [job.id]: check }));
        if (check === 'mismatch') toast.error(t('hash.mismatch'));
      },
      onError: (err) => toast.error(apiMessage(err)),
      onSettled: () => setDownloadingId(null),
    });
  }

  function handleAck(note?: string) {
    if (!ackTarget?.job.fileHash) return;
    const { job, result } = ackTarget;
    const checksum = job.fileHash as string;
    setAckError(null);
    ackMutation.mutate(
      { id: job.id, result, checksum, ...(note ? { note } : {}), idempotencyKey: (ackKey.current ??= crypto.randomUUID()) },
      {
        onSuccess: () => {
          ackKey.current = null;
          setAckTarget(null);
          toast.success(result === 'ACCEPTED' ? t('ack.doneAccepted') : t('ack.doneRejected'));
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status < 500) ackKey.current = null;
          setAckError(apiMessage(err));
        },
      },
    );
  }

  function openAck(job: ExportJob, result: 'ACCEPTED' | 'REJECTED') {
    ackKey.current = null;
    setAckError(null);
    setAckTarget({ job, result });
  }

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      toast.success(t('hash.copied'));
    } catch {
      toast.error(t('hash.copyFailed'));
    }
  }

  const rows = jobs.data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => jobs.refetch()} disabled={jobs.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${jobs.isFetching ? 'animate-spin' : ''}`} />
          {t('refresh')}
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="exportFrom">{t('form.from')}</Label>
              <Input id="exportFrom" type="date" value={from} max={maxDate} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="exportTo">{t('form.to')}</Label>
              <Input id="exportTo" type="date" value={to} min={from || undefined} max={maxDate} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="exportFormat">{t('form.format')}</Label>
              <Select id="exportFormat" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(`format.${f}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-end">
              <Button className="min-h-12 w-full" onClick={handleCreate} disabled={createMutation.isPending || periodInvalid}>
                {createMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileOutput className="mr-2 h-4 w-4" />}
                {t('form.create')}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('form.hint', { date: formatDateInZone(`${maxDate}T12:00:00Z`, locale, 'UTC') })}</p>
          {from && to && periodInvalid && (
            <p className="flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              {t('form.periodInvalid')}
            </p>
          )}
          {format === 'XML' && (
            <p className="flex items-center gap-1 text-xs text-warning-foreground">
              <AlertTriangle className="h-3 w-3" />
              {t('form.xmlUnverified')}
            </p>
          )}
          {createError && (
            <Alert variant="destructive">
              <AlertDescription>{createError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {jobs.isLoading && (
        <Card>
          <CardContent className="space-y-2 py-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      )}

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

      {jobs.data && rows.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <FileOutput className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && jobs.data && (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('col.status')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.period')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.format')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.records')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.file')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.generated')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('col.ack')}</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border align-top">
                  {rows.map((job) => {
                    const check = hashChecks[job.id];
                    const canDownload = DOWNLOADABLE_EXPORT_STATUSES.includes(job.status);
                    return (
                      <tr key={job.id}>
                        <td className="py-2 pr-3">
                          <Badge variant={STATUS_VARIANT[job.status]}>{t(`status.${job.status}`)}</Badge>
                          {job.status === 'FAILED' && (
                            <p className="mt-1 flex max-w-xs items-start gap-1 text-xs text-destructive">
                              <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                              <span className="break-words">{job.errorLog?.message ?? t('failedUnknown')}</span>
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          {formatDateInZone(job.periodFrom, locale, tz)} – {formatDateInZone(job.periodTo, locale, tz)}
                        </td>
                        <td className="py-2 pr-3">
                          {t(`format.${job.format}`)}
                        </td>
                        <td className="py-2 pr-3">{job.recordCount ?? '—'}</td>
                        <td className="py-2 pr-3">
                          {job.fileName ? <div className="break-all">{job.fileName}</div> : '—'}
                          {job.fileHash && (
                            <div className="mt-1 flex items-center gap-1 font-mono text-xs text-muted-foreground">
                              <span title={job.fileHash}>{shortHash(job.fileHash)}</span>
                              <Button variant="ghost" size="sm" aria-label={t('hash.copy')} onClick={() => copyHash(job.fileHash as string)}>
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                          {check && (
                            <p
                              className={`mt-1 flex items-center gap-1 text-xs ${check === 'match' ? 'text-success' : check === 'mismatch' ? 'text-destructive' : 'text-muted-foreground'}`}
                            >
                              {check === 'match' ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                              {t(`hash.${check}`)}
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{job.generatedAt ? formatDateTime(job.generatedAt, locale) : '—'}</td>
                        <td className="py-2 pr-3">
                          {job.acknowledgedAt ? (
                            <div className="text-xs">
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                {formatDateTime(job.acknowledgedAt, locale)}
                              </span>
                              {job.ackNote && <span className="mt-1 block max-w-xs break-words text-muted-foreground">{job.ackNote}</span>}
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap justify-end gap-2">
                            {canDownload && (
                              <Button variant="outline" size="sm" className="min-h-12" onClick={() => handleDownload(job)} disabled={downloadingId === job.id}>
                                {downloadingId === job.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                                {t('download')}
                              </Button>
                            )}
                            {canAck && job.status === 'GENERATED' && (
                              <>
                                <Button size="sm" className="min-h-12" onClick={() => openAck(job, 'ACCEPTED')}>
                                  {t('ack.accept')}
                                </Button>
                                <Button variant="destructive" size="sm" className="min-h-12" onClick={() => openAck(job, 'REJECTED')}>
                                  {t('ack.reject')}
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationBar meta={jobs.data.meta} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={ackTarget?.result === 'ACCEPTED'}
        onOpenChange={(open) => !open && setAckTarget(null)}
        title={t('ack.acceptTitle')}
        description={t('ack.acceptDescription', { file: ackTarget?.job.fileName ?? '' })}
        confirmLabel={t('ack.accept')}
        error={ackError}
        isPending={ackMutation.isPending}
        onConfirm={() => handleAck()}
      />
      {ackTarget?.result === 'REJECTED' && (
        <ReverseDialog
          open
          onOpenChange={(open) => !open && setAckTarget(null)}
          title={t('ack.rejectTitle')}
          description={t('ack.rejectDescription', { file: ackTarget.job.fileName ?? '' })}
          confirmLabel={t('ack.reject')}
          error={ackError}
          isPending={ackMutation.isPending}
          onConfirm={(reason) => handleAck(reason)}
        />
      )}
    </div>
  );
}
