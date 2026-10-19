'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { usePaymentsQuery } from '@/lib/api/payments';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { queueRepository } from '@/lib/offline/queue';
import { useOfflineCustomers, useOfflineOutlets, useOfflineProducts } from '@/lib/offline/use-offline-data';
import { downloadJson, entryDisplayName, exportFileName, needsAttention, sortQueueForScreen } from '@/lib/offline/queue-view';
import { ConfirmSheet } from '@/components/shared/confirm-sheet';
import { QueueItemCard } from '@/components/queue/queue-item-card';
import { LogoutButton } from '@/components/queue/logout-button';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function QueuePage() {
  const t = useTranslations('Queue');
  const router = useRouter();
  const engine = useSyncEngine();
  useTelegramBackButton(useCallback(() => router.push('/'), [router]));

  // Key includes the counters so the list refreshes after every sync cycle, not only after a pull.
  const entries = useQuery({
    queryKey: ['offline', 'queue', 'all', engine.pendingCount, engine.failedCount, engine.conflictCount, engine.unsyncedCount],
    queryFn: () => queueRepository.listAll(),
    staleTime: 0,
  });
  const quarantined = useQuery({
    queryKey: ['offline', 'queue', 'quarantined', engine.unsyncedCount],
    queryFn: () => queueRepository.listQuarantined(),
    staleTime: 0,
  });
  const [discardId, setDiscardId] = useState<string | null>(null);
  const customers = useOfflineCustomers();
  const outlets = useOfflineOutlets();
  const products = useOfflineProducts();

  const productName = useCallback((id: string) => products.data?.find((p) => p.id === id)?.name ?? '—', [products.data]);
  // Learn the cashier's decision (POSTED/REJECTED) for payments still waiting on handover — online only.
  const awaitingHandover = (entries.data ?? []).some((e) => e.type === 'payment' && e.paymentStatus === 'PENDING_HANDOVER');
  const handover = usePaymentsQuery({ pageSize: 100 }, engine.isOnline && awaitingHandover);
  useEffect(() => {
    const items = handover.data?.data;
    if (!items) return;
    void Promise.all(items.map((p) => queueRepository.applyHandoverStatus(p.id, p.status, p.handoverRejectReason))).then((r) => {
      if (r.some(Boolean)) void entries.refetch();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handover.data]);

  const rows = sortQueueForScreen(entries.data ?? []);
  const attention = rows.filter(needsAttention);
  const waiting = rows.filter((e) => e.status === 'PENDING' || e.status === 'SYNCING');
  const synced = rows.filter((e) => e.status === 'SYNCED' && !needsAttention(e));

  function refresh() {
    void entries.refetch();
    engine.notifyQueueChanged();
  }

  async function onExport() {
    const json = await queueRepository.exportPendingToJson();
    if ((JSON.parse(json) as { items: unknown[] }).items.length === 0) {
      toast.message(t('exportEmpty'));
      return;
    }
    downloadJson(json, exportFileName());
    toast.success(t('exportDone'));
  }

  async function onExportQuarantined() {
    downloadJson(await queueRepository.exportQuarantinedToJson(), exportFileName());
    toast.warning(t('quarantineExportWarning'));
  }

  const section = (title: string, list: typeof rows) =>
    list.length > 0 && (
      <section className="space-y-2" aria-label={title}>
        <h2 className="text-sm font-medium text-muted-foreground">
          {title} ({list.length})
        </h2>
        {list.map((e) => (
          <QueueItemCard
            key={e.clientId}
            entry={e}
            name={entryDisplayName(e, customers.data ?? [], outlets.data ?? [])}
            productName={productName}
            onChanged={refresh}
          />
        ))}
      </section>
    );

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t('title')}</h1>

      {entries.isLoading && <Skeleton className="h-24 w-full" />}
      {!entries.isLoading && rows.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}

      {section(t('attentionTitle'), attention)}
      {section(t('pendingTitle'), waiting)}
      {section(t('syncedTitle'), synced)}

      {(quarantined.data?.length ?? 0) > 0 && (
        <section className="space-y-2 rounded-md border border-destructive/40 p-3" aria-label={t('quarantineTitle')}>
          <h2 className="text-sm font-medium">
            {t('quarantineTitle')} ({quarantined.data?.length})
          </h2>
          <p className="text-xs text-muted-foreground">{t('quarantineWarning')}</p>
          {quarantined.data?.map((e) => (
            <div key={e.clientId} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {e.type} · {e.createdAt.slice(0, 16).replace('T', ' ')}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => setDiscardId(e.clientId)}>
                {t('quarantineDiscard')}
              </Button>
            </div>
          ))}
          <Button type="button" variant="secondary" size="lg" className="w-full gap-2" onClick={() => void onExportQuarantined()}>
            <Download className="h-4 w-4" aria-hidden="true" />
            {t('quarantineExport')}
          </Button>
        </section>
      )}
      <ConfirmSheet
        open={discardId !== null}
        onOpenChange={(o) => !o && setDiscardId(null)}
        title={t('quarantineDiscardConfirmTitle')}
        description={t('quarantineDiscardConfirmDescription')}
        confirmLabel={t('quarantineDiscardConfirm')}
        onConfirm={async () => {
          if (discardId) await queueRepository.discardQuarantinedItem(discardId);
          setDiscardId(null);
          void quarantined.refetch();
          engine.notifyQueueChanged();
        }}
      />

      <div className="space-y-2 pt-2">
        <Button type="button" variant="secondary" size="lg" className="w-full gap-2" onClick={() => void onExport()}>
          <Download className="h-4 w-4" aria-hidden="true" />
          {t('exportButton')}
        </Button>
        <LogoutButton />
      </div>
    </div>
  );
}
