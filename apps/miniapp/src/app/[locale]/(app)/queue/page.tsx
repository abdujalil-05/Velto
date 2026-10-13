'use client';

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { useTelegramBackButton } from '@/lib/hooks/use-telegram-back-button';
import { useSyncEngine } from '@/lib/offline/sync-engine';
import { queueRepository } from '@/lib/offline/queue';
import { useOfflineCustomers, useOfflineOutlets, useOfflineProducts } from '@/lib/offline/use-offline-data';
import { downloadJson, entryDisplayName, exportFileName, sortQueueForScreen } from '@/lib/offline/queue-view';
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
  const customers = useOfflineCustomers();
  const outlets = useOfflineOutlets();
  const products = useOfflineProducts();

  const productName = useCallback((id: string) => products.data?.find((p) => p.id === id)?.name ?? '—', [products.data]);
  const rows = sortQueueForScreen(entries.data ?? []);
  const attention = rows.filter((e) => e.status === 'FAILED' || e.status === 'CONFLICT');
  const waiting = rows.filter((e) => e.status === 'PENDING' || e.status === 'SYNCING');
  const synced = rows.filter((e) => e.status === 'SYNCED');

  function refresh() {
    void entries.refetch();
    engine.notifyQueueChanged();
  }

  async function onExport() {
    const json = await queueRepository.exportPendingToJson({ scope: 'own' });
    if ((JSON.parse(json) as { items: unknown[] }).items.length === 0) {
      toast.message(t('exportEmpty'));
      return;
    }
    downloadJson(json, exportFileName());
    toast.success(t('exportDone'));
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
