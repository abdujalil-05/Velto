'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth/auth-context';
import { queueRepository } from './queue';
import { runPull, runPush } from './sync-engine-core';

const FLUSH_INTERVAL_MS = 30_000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface SyncEngineValue {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  failedCount: number;
  lastSyncAt: Date | null;
  /** Screens call this right after `queueRepository.enqueue(...)` so the badge updates immediately and a push is attempted without waiting for the next interval tick. */
  notifyQueueChanged: () => void;
  forceSyncNow: () => void;
}

const SyncEngineContext = createContext<SyncEngineValue | null>(null);

export function SyncEngineProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const t = useTranslations('Common');
  const queryClient = useQueryClient();

  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);

  const backoffRef = useRef(MIN_BACKOFF_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  const refreshCounts = useCallback(async () => {
    const all = await queueRepository.listAll();
    setPendingCount(all.filter((e) => e.status === 'PENDING').length);
    setFailedCount(all.filter((e) => e.status === 'FAILED').length);
  }, []);

  const cycle = useCallback(
    async (opts: { pull: boolean }) => {
      if (status !== 'authenticated') return;
      // Both callers (notifyQueueChanged/forceSyncNow) clear the pending
      // timer before calling in, so bailing out here without re-arming it
      // left the app with no scheduled sync at all — every offline save
      // disarmed the loop, and it only ever came back if the browser
      // happened to fire an `online` event (unreliable in Telegram's
      // WebView, and never fired at all when connectivity returns without a
      // navigator.onLine transition). Re-arm before returning.
      if (runningRef.current || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        scheduleNext();
        return;
      }

      runningRef.current = true;
      setIsSyncing(true);
      let didPull = false;
      try {
        if (opts.pull) {
          await runPull();
          didPull = true;
        }
        const outcome = await runPush();
        if (outcome.accepted > 0) {
          // Freshly-confirmed docs can change stock/balances (e.g. a
          // just-approved order reserving stock) — pull again so the next
          // screen render reflects it, without waiting a full interval.
          await runPull();
          didPull = true;
        }
        backoffRef.current = MIN_BACKOFF_MS;
        setLastSyncAt(new Date());
      } catch {
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      } finally {
        runningRef.current = false;
        setIsSyncing(false);
        await refreshCounts();
        if (didPull) await queryClient.invalidateQueries({ queryKey: ['offline'] });
        scheduleNext();
      }
    },
    [status, t, refreshCounts, queryClient],
  );

  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const delay = backoffRef.current > MIN_BACKOFF_MS ? backoffRef.current : FLUSH_INTERVAL_MS;
    timerRef.current = setTimeout(() => void cycle({ pull: false }), delay);
  }, [cycle]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    void refreshCounts();
    void cycle({ pull: true });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Intentionally only re-runs on `status` changes — `cycle` closes over
    // it and is recreated with it, so this still starts a fresh cycle on
    // every login/logout without needing `cycle` itself in the dep array.
  }, [status]);

  useEffect(() => {
    function onOnline() {
      setIsOnline(true);
      backoffRef.current = MIN_BACKOFF_MS;
      void cycle({ pull: true });
    }
    function onOffline() {
      setIsOnline(false);
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
    // Re-subscribes whenever `cycle` changes identity (chiefly on `status`
    // transitions) — without `cycle` in the deps, `onOnline` would keep
    // closing over the very first render's `cycle`, permanently bound to
    // the pre-auth `status: 'loading'` it bails out on, so reconnect would
    // silently never trigger a sync.
  }, [cycle]);

  const notifyQueueChanged = useCallback(() => {
    void refreshCounts();
    void queryClient.invalidateQueries({ queryKey: ['offline', 'queue'] });
    if (timerRef.current) clearTimeout(timerRef.current);
    void cycle({ pull: false });
  }, [refreshCounts, queryClient, cycle]);

  const forceSyncNow = useCallback(() => {
    backoffRef.current = MIN_BACKOFF_MS;
    if (timerRef.current) clearTimeout(timerRef.current);
    void cycle({ pull: true });
  }, [cycle]);

  return (
    <SyncEngineContext.Provider
      value={{ isOnline, isSyncing, pendingCount, failedCount, lastSyncAt, notifyQueueChanged, forceSyncNow }}
    >
      {children}
    </SyncEngineContext.Provider>
  );
}

export function useSyncEngine(): SyncEngineValue {
  const ctx = useContext(SyncEngineContext);
  if (!ctx) throw new Error('useSyncEngine must be used within SyncEngineProvider');
  return ctx;
}
