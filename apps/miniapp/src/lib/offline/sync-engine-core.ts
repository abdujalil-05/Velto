import type { GpsStatus } from '@/lib/gps-payload';
import { ApiError, degradedKind, type DegradedKind } from '@/lib/api/client';
import { pullSync, pushSync, type SyncPushResultItem } from '@/lib/api/sync';
import { applyPull, getCursor, markPullComplete } from './repository';
import { queueRepository, type QueueEntry, type QueueError } from './queue';
import { bringUpVault, hasSealedFor, resolveHeldRows, restoreSealedFor, type HeldResolved } from './held-seal';
import { getVaultStatus } from './vault';
import { abortSyncRequests, getOfflineSession, getSyncSignal, isSyncPaused, setSyncPaused } from './session';
import { prepareOfflineSession } from './session-bootstrap';
import { enforceStorageBudget } from './storage-budget';

/** Plain (non-React) sync primitives — kept separate from sync-engine.tsx so the provider can layer translated toasts on top. */

const PULL_PAGE_LIMIT = 500;
/** Safety valve against a server that never clears hasMore. */
const MAX_PULL_PAGES = 200;

/**
 * Pulls until `hasMore` is false, applying each page atomically with its
 * cursor (stored exactly as returned). A fullResync rebuilds customers/outlets
 * once, on the first page that announces it.
 */
export async function runPull(): Promise<{ pages: number }> {
  if (!(await prepareOfflineSession())) return { pages: 0 };
  let cursor = await getCursor();
  let rebuilt = false;
  let pages = 0;
  for (; pages < MAX_PULL_PAGES; ) {
    const result = await pullSync(cursor, PULL_PAGE_LIMIT);
    pages += 1;
    const rebuild = result.fullResync && !rebuilt;
    if (result.fullResync) rebuilt = true;
    await applyPull(result, { rebuild });
    cursor = result.cursor;
    if (!result.hasMore) break;
  }
  await markPullComplete();
  await queueRepository.pruneOld();
  await enforceStorageBudget();
  return { pages };
}

export interface PushOutcome {
  accepted: number;
  /** FAILED (REJECTED, 403, max attempts) this run. */
  rejected: number;
  conflicts: number;
  /** Items put back to PENDING with backoff. */
  retried: number;
  /** Server GPS verdicts of just-synced visits (only entries where the server sent one). */
  visitGps: { clientId: string; gpsStatus: GpsStatus; distanceM: string | null }[];
  /** AUTH: 401 survived a token refresh -> paused (nothing marked failed). NETWORK: request failed / 5xx -> stopped for backoff. */
  paused: 'AUTH' | 'NETWORK' | 'DEGRADED' | null;
  /** Set with paused 'DEGRADED': 503 maintenance / 429 — documents wait (PENDING, attempt not counted). */
  degraded?: DegradedKind;
  /** Ms until the earliest backed-off item becomes due (for the scheduler). */
  nextRetryInMs?: number;
}

/** TZ 8.3: 20 per request unless the server says less (SYNC_BATCH_TOO_LARGE halves it for this app run). */
export const DEFAULT_PUSH_BATCH = 20;
let batchLimit = DEFAULT_PUSH_BATCH;
const MAX_BATCHES_PER_CYCLE = 25;

export function resetPushBatchLimit(): void {
  batchLimit = DEFAULT_PUSH_BATCH;
}

function toQueueError(error: SyncPushResultItem['error'], fallbackCode: string): QueueError {
  return {
    code: error?.code ?? fallbackCode,
    message: error?.message ?? fallbackCode,
    ...(error?.messages ? { messages: error.messages } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

/**
 * Pushes the CURRENT user's PENDING documents (never anyone else's), FIFO
 * with visit-before-order per outlet, in batches. Per-item outcomes:
 * ACCEPTED/DUPLICATE -> SYNCED(+serverId); REJECTED -> FAILED; CONFLICT ->
 * CONFLICT (details kept); RETRY / missing result -> PENDING+backoff (FAILED
 * SYNC_MAX_ATTEMPTS at the cap). Request-level: 401 -> pause; 503 MAINTENANCE_READ_ONLY / 429 -> PENDING until Retry-After, attempt not counted (F7); 403 -> batch
 * FAILED; other errors -> PENDING+backoff. Items sent without an ACK stay
 * unsent-able and are re-sent later with the SAME clientId (server dedupes).
 */
export function runPush(): Promise<PushOutcome> {
  return track(pushInner());
}

const inFlight = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  const done = () => inFlight.delete(p);
  p.then(done, done);
  return p;
}

/** Logout step 1: no new push/resolution starts, and any running one finishes before the caller touches the queue. */
export const STOP_SYNC_WAIT_MS = 5_000;

/**
 * Logout step 1: no new push/resolution starts, running requests are aborted, and the caller waits for them to
 * settle - but at most `maxWaitMs`, so a hung request can never block logout. A completion after the cap
 * cannot write a PAYMENT row (the vault is locked by then; queue.ts refuses device-key payment writes).
 */
export async function stopSyncAndWait(maxWaitMs: number = STOP_SYNC_WAIT_MS): Promise<void> {
  setSyncPaused(true);
  abortSyncRequests();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
    }),
  ]);
  clearTimeout(timer);
}

/** Aborts a logout that did not proceed (e.g. blocked by unsynced documents). */
export function resumeSync(): void {
  setSyncPaused(false);
}

/**
 * Online + owner signed in (session comes from /auth/me): restore the owner's
 * sealed held rows (KEK fetched, kept in memory only), then ask the server
 * whether any held payment is resolved. Offline / errors keep everything.
 */
let unrestorableSealed = 0;
/** Sealed rows the last maintenance run could not open (kept sealed); the caller warns the user. */
export function unrestorableSealedCount(): number {
  return unrestorableSealed;
}

export function runHeldMaintenance(): Promise<HeldResolved[]> {
  return track(maintenanceInner());
}

async function maintenanceInner(): Promise<HeldResolved[]> {
  const s = getOfflineSession();
  if (!s || isSyncPaused()) return [];
  try {
    if (getVaultStatus() !== 'ready') unrestorableSealed = (await bringUpVault(s)).legacyFailed; // retry after an offline/failed start
    else if (await hasSealedFor(s)) unrestorableSealed = (await restoreSealedFor(s)).failed;
  } catch {
    /* offline / no KEK: stays locked/sealed, retried next cycle */
  }
  if (isSyncPaused()) return [];
  return resolveHeldRows();
}

async function pushInner(): Promise<PushOutcome> {
  const outcome: PushOutcome = { accepted: 0, rejected: 0, conflicts: 0, retried: 0, visitGps: [], paused: null };
  if (isSyncPaused() || !(await prepareOfflineSession()) || !getOfflineSession()) return outcome;

  for (let n = 0; n < MAX_BATCHES_PER_CYCLE; n++) {
    if (isSyncPaused()) break;
    const batch = await queueRepository.listPushable(batchLimit);
    if (batch.length === 0) break;
    const ids = batch.map((e) => e.clientId);
    await queueRepository.markSyncing(ids);

    let results: SyncPushResultItem[];
    try {
      ({ results } = await pushSync(batch.map((e) => ({ type: e.type, clientId: e.clientId, payload: e.payload })), getSyncSignal()));
    } catch (err) {
      if (isSyncPaused()) {
        // Logout / session end aborted the request: no ACK, attempt not counted; same clientId is re-sent later (server dedupes).
        await queueRepository.releaseUnsent(ids).catch(() => {});
        break;
      }
      const stop = await handleRequestError(err, batch, outcome);
      if (stop) break;
      continue;
    }

    const byId = new Map(results.map((r) => [r.clientId, r]));
    const applied = new Set<string>();
    try {
      for (const entry of batch) {
        await applyResult(entry, byId.get(entry.clientId), outcome);
        applied.add(entry.clientId);
      }
    } finally {
      // A failed put (quota) must not strand the rest in SYNCING: release them
      // to PENDING (attempt not counted); the server dedupes the re-send by clientId.
      const rest = ids.filter((id) => !applied.has(id));
      if (rest.length > 0) await queueRepository.releaseUnsent(rest).catch(() => {});
    }
  }

  const waiting = (await queueRepository.listAll()).filter((e) => e.status === 'PENDING' && e.nextAttemptAt && !e.quarantinedAt);
  if (waiting.length > 0) {
    const earliest = waiting.map((e) => Date.parse(e.nextAttemptAt!)).sort((a, b) => a - b)[0]!;
    outcome.nextRetryInMs = Math.max(1_000, earliest - Date.now());
  }
  return outcome;
}

async function applyResult(entry: QueueEntry, result: SyncPushResultItem | undefined, outcome: PushOutcome): Promise<void> {
  switch (result?.status) {
    case 'ACCEPTED':
    case 'DUPLICATE':
      await queueRepository.markSynced(entry.clientId, result.id, result.paymentStatus);
      outcome.accepted += 1;
      if (result.gpsStatus) outcome.visitGps.push({ clientId: entry.clientId, gpsStatus: result.gpsStatus, distanceM: result.distanceM ?? null });
      return;
    case 'REJECTED':
      await queueRepository.markFailed(entry.clientId, toQueueError(result.error, 'SYNC_REJECTED'));
      outcome.rejected += 1;
      return;
    case 'CONFLICT':
      await queueRepository.markConflict(entry.clientId, toQueueError(result.error, 'SYNC_CONFLICT'));
      outcome.conflicts += 1;
      return;
    default:
      // RETRY, an unknown status, or no result for this clientId: no ACK.
      await queueRepository.markRetry(entry.clientId, result ? toQueueError(result.error, 'SYNC_RETRY') : { code: 'SYNC_NO_RESULT', message: 'No result for item' });
      outcome.retried += 1;
  }
}

/** Returns true when the cycle must stop. */
async function handleRequestError(err: unknown, batch: QueueEntry[], outcome: PushOutcome): Promise<boolean> {
  const ids = batch.map((e) => e.clientId);
  if (err instanceof ApiError) {
    if (err.status === 401) {
      // apiFetch already tried one refresh; the session is gone — pause, do not fail the work.
      await queueRepository.releaseUnsent(ids);
      outcome.paused = 'AUTH';
      return true;
    }
    if (err.status === 403) {
      for (const id of ids) {
        await queueRepository.markFailed(id, { code: err.code, message: err.localizedMessage?.uz || err.message, messages: err.localizedMessage });
      }
      outcome.rejected += ids.length;
      return false;
    }
    const degraded = degradedKind(err);
    if (degraded) {
      // TZ 12.5: nothing is lost, failed or counted — wait out Retry-After, same clientId.
      await queueRepository.deferRetry(ids, { code: err.code, message: err.localizedMessage?.uz || err.message, messages: err.localizedMessage }, err.retryAfterMs);
      outcome.paused = 'DEGRADED';
      outcome.degraded = degraded;
      return true;
    }
    if (err.code === 'SYNC_BATCH_TOO_LARGE' && batchLimit > 1) {
      batchLimit = Math.max(1, Math.floor(batchLimit / 2));
      await queueRepository.releaseUnsent(ids);
      return false;
    }
  }
  const code = err instanceof ApiError ? err.code : 'NETWORK_ERROR';
  for (const id of ids) await queueRepository.markRetry(id, { code, message: err instanceof Error ? err.message : code });
  outcome.retried += ids.length;
  outcome.paused = 'NETWORK';
  return true;
}
