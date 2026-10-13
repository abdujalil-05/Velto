'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth/auth-context';
import { queueRepository } from './queue';
import { getLastStorageStatus, onStorageStatus, publishStorageStatus, type StorageStatus } from './storage-budget';
import { runPull, runPush } from './sync-engine-core';

const FLUSH_INTERVAL_MS = 30_000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface SyncEngineValue {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  /** PENDING + SYNCING + FAILED + CONFLICT — documents still only on this device. */
  unsyncedCount: number;
  /** Device storage vs the 50 MB budget; `level === 'warning'` from 80%. */
  storage: StorageStatus;
  /** True after a 401 survived refresh: sync is paused until the user signs in again. */
  authPaused: boolean;
  lastSyncAt: Date | null;
  /** Screens call this right after `queueRepository.enqueue(...)` so the badge updates immediately and a push is attempted without waiting for the next interval tick. */
  notifyQueueChanged: () => void;
  forceSyncNow: () => void;
}

const SyncEngineContext = createContext<SyncEngineValue | null>(null);

export function SyncEngineProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const t = useTranslations('Common');
  const tVisit = useTranslations('Visit');
  const queryClient = useQueryClient();

  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [storage, setStorage] = useState<StorageStatus>(getLastStorageStatus);
  const [authPaused, setAuthPaused] = useState(false);
  const nextDelayRef = useRef<number | undefined>(undefined);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);

  const backoffRef = useRef(MIN_BACKOFF_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  const refreshCounts = useCallback(async () => {
    const counts = await queueRepository.countByStatus();
    setPendingCount(counts.PENDING + counts.SYNCING);
    setFailedCount(counts.FAILED);
    setConflictCount(counts.CONFLICT);
    setUnsyncedCount(counts.unsynced);
  }, []);

  useEffect(() => {
    void publishStorageStatus().catch(() => {});
    return onStorageStatus(setStorage);
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
        for (const v of outcome.visitGps) {
          if (v.gpsStatus !== 'VERIFIED') toast.warning(tVisit(`gpsStatus.${v.gpsStatus}`));
        }
        if (outcome.accepted > 0) {
          // Freshly-confirmed docs can change stock/balances (e.g. a
          // just-approved order reserving stock) — pull again so the next
          // screen render reflects it, without waiting a full interval.
          await runPull();
          didPull = true;
        }
        setAuthPaused(outcome.paused === 'AUTH');
        nextDelayRef.current = outcome.nextRetryInMs;
        if (outcome.paused === 'NETWORK') {
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        } else {
          backoffRef.current = MIN_BACKOFF_MS;
          if (outcome.paused === null) setLastSyncAt(new Date());
        }
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
    [status, t, tVisit, refreshCounts, queryClient],
  );

  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const base = backoffRef.current > MIN_BACKOFF_MS ? backoffRef.current : FLUSH_INTERVAL_MS;
    const delay = nextDelayRef.current !== undefined ? Math.min(base, nextDelayRef.current) : base;
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
      value={{ isOnline, isSyncing, pendingCount, failedCount, conflictCount, unsyncedCount, storage, authPaused, lastSyncAt, notifyQueueChanged, forceSyncNow }}
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
