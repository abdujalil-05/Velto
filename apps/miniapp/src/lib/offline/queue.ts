import type { PaymentStatus } from '@/lib/api/payments';
import type { SyncDocType } from '@/lib/api/sync';
import { db, QUEUE_SEQ_KEY } from './db';
import { EncryptedStore } from './encrypted-store';
import { getOfflineSession, NoOfflineSessionError, type OfflineSession } from './session';
import { publishStorageStatus } from './storage-budget';

/**
 * Local sync queue (TZ 8.2/8.3). One table, the single source for the sync
 * badge, the "needs attention" list and Home/Route/Report's offline "today"
 * stats.
 *
 * Status machine:
 *   PENDING  --send-->  SYNCING --ACCEPTED/DUPLICATE--> SYNCED (serverId kept)
 *                               --REJECTED / 403 / max attempts--> FAILED (never auto-retried)
 *                               --CONFLICT--> CONFLICT (server details kept, never auto-retried)
 *                               --RETRY / network / 5xx--> PENDING (backoff, attemptCount+1)
 * SYNCING is only ever in-flight; a crash/kill leaves it behind and
 * `releaseStaleSyncing` returns it to PENDING (same clientId -> server dedupes).
 * Nothing leaves the queue before server ACK; FAILED/CONFLICT leave only via
 * the explicit `discardFailedItem` / `resolveConflictResubmit`.
 */
export type QueueStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT';

/** Statuses the server has NOT accepted — the user's work that still exists only on this device. */
export const UNSYNCED_STATUSES: readonly QueueStatus[] = ['PENDING', 'SYNCING', 'FAILED', 'CONFLICT'];

export const QUEUE_SCHEMA_VERSION = 1;
/** After this many send attempts a deterministic-looking failure becomes FAILED/SYNC_MAX_ATTEMPTS. */
export const MAX_SYNC_ATTEMPTS = 8;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export interface QueueError {
  code: string;
  /** Uzbek (server `message`); UI should prefer `messages[locale]` when present. */
  message: string;
  messages?: { uz: string; ru: string; en: string };
  /** CONFLICT/PRICE_CHANGED: { lines:[{lineIndex,productId,packagingId,expectedUnitPrice,serverUnitPrice}], expectedTotal, serverTotal }. */
  details?: unknown;
}

export interface QueueEntry {
  clientId: string;
  type: SyncDocType;
  status: QueueStatus;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Per-device monotonic FIFO order (createdAt ties within a ms). Display still uses createdAt. */
  seq?: number;
  schemaVersion: number;
  attemptCount: number;
  lastAttemptAt?: string;
  /** ISO — an entry is not re-sent before this (exponential backoff). */
  nextAttemptAt?: string;
  lastError?: QueueError;
  /** Server id (order/visit/payment) once ACKed. */
  serverId?: string;
  /** Payment entries: server status from the push ACK / later reconcile (ADR-029). */
  paymentStatus?: PaymentStatus;
  handoverRejectReason?: string;
  userId?: string;
  companyId?: string;
  /** ISO — set when the session was revoked/blocked by the server: the row keeps its owner but is NEVER pushed; only export / confirmed discard (ADR-022 quarantine). */
  quarantinedAt?: string;
}

/** Thrown by `enqueue` when the device has no room — nothing was written, existing items are untouched. */
export class QueueQuotaError extends Error {
  readonly code = 'STORAGE_QUOTA_EXCEEDED';
  constructor() {
    super('Device storage is full: document was NOT saved');
    this.name = 'QueueQuotaError';
  }
}

export class QueueItemStateError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'NOT_DISCARDABLE' | 'NOT_RESOLVABLE',
    message: string,
  ) {
    super(message);
    this.name = 'QueueItemStateError';
  }
}

const store = new EncryptedStore<QueueEntry, string>(db.queue as never, [
  'clientId',
  'type',
  'status',
  'createdAt',
  'userId',
  'companyId',
  'seq',
], ['seq']);

const NO_SEQ = Number.MAX_SAFE_INTEGER;
/** FIFO comparator: seq, then createdAt, then clientId (legacy rows without seq sort last, stably). */
function bySeq(a: QueueEntry, b: QueueEntry): number {
  return (a.seq ?? NO_SEQ) - (b.seq ?? NO_SEQ) || a.createdAt.localeCompare(b.createdAt) || a.clientId.localeCompare(b.clientId);
}

/** Allocates the next sequence atomically (no crypto inside the Dexie transaction). */
async function nextSeq(): Promise<number> {
  return db.transaction('rw', [db.meta, db.queue], async () => {
    const counter = ((await db.meta.get(QUEUE_SEQ_KEY))?.value as number | undefined) ?? 0;
    const top = (await db.queue.orderBy('seq').last())?.seq ?? 0;
    const next = Math.max(counter, top) + 1;
    await db.meta.put({ key: QUEUE_SEQ_KEY, value: next });
    return next;
  });
}

function isQuotaError(e: unknown): boolean {
  const err = e as { name?: string; inner?: { name?: string }; code?: number } | null;
  return err?.name === 'QuotaExceededError' || err?.inner?.name === 'QuotaExceededError' || err?.code === 22;
}

/** v2 rows predate attemptCount/schemaVersion/owner — fill defaults on read, never rewrite on disk. */
function normalize(e: QueueEntry): QueueEntry {
  const legacy = e as QueueEntry & { error?: QueueError };
  return {
    ...e,
    schemaVersion: e.schemaVersion ?? QUEUE_SCHEMA_VERSION,
    attemptCount: e.attemptCount ?? 0,
    lastError: e.lastError ?? legacy.error,
  };
}

function ownedBy(e: QueueEntry, s: OfflineSession | null): boolean {
  return !!s && e.userId === s.userId && e.companyId === s.companyId;
}

async function readAll(): Promise<QueueEntry[]> {
  return (await store.toArray()).map(normalize);
}

/** Exponential 2s..5min with +0..25% jitter (never above the 5 min cap). */
export function backoffDelayMs(attemptCount: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attemptCount - 1));
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (1 + random() * 0.25)));
}

/**
 * Queues a document and returns once it is durably on THIS DEVICE ("saqlandi
 * qurilmada") — that is not server acceptance. Stamped with the current
 * user/company. Throws `QueueQuotaError` when the device is full (nothing is
 * written, existing PENDING items are untouched) and `NoOfflineSessionError`
 * without a session.
 */
export async function enqueue(type: SyncDocType, payload: Record<string, unknown>): Promise<string> {
  const session = getOfflineSession();
  if (!session) throw new NoOfflineSessionError();
  const clientId = crypto.randomUUID();
  const seq = await nextSeq();
  const entry: QueueEntry = {
    clientId,
    type,
    status: 'PENDING',
    payload: { ...payload, clientId },
    createdAt: new Date().toISOString(),
    seq,
    schemaVersion: QUEUE_SCHEMA_VERSION,
    attemptCount: 0,
    userId: session.userId,
    companyId: session.companyId,
  };
  try {
    await store.put(entry);
  } catch (e) {
    if (isQuotaError(e)) {
      void publishStorageStatus().catch(() => {});
      throw new QueueQuotaError();
    }
    throw e;
  }
  void publishStorageStatus().catch(() => {});
  return clientId;
}

/** Current user's entries only — other users' documents are never listed. */
export async function listAll(): Promise<QueueEntry[]> {
  const s = getOfflineSession();
  return (await readAll()).filter((e) => ownedBy(e, s));
}

/** All owners — ONLY for the logout guard / export flow. */
export async function listAllOwners(): Promise<QueueEntry[]> {
  return readAll();
}

export async function listPending(limit = 20): Promise<QueueEntry[]> {
  return (await listAll())
    .filter((e) => e.status === 'PENDING' && !e.quarantinedAt)
    .sort(bySeq)
    .slice(0, limit);
}

/**
 * Current user's PENDING items that may be sent now (backoff elapsed), in
 * push order: FIFO by seq, except a visit goes before an order of the
 * same outlet, and an order waits while a same-outlet visit is still
 * unsynced but not yet due (backoff).
 */
export async function listPushable(limit: number, now: Date = new Date()): Promise<QueueEntry[]> {
  const mine = (await listAll()).filter((e) => e.status === 'PENDING' && !e.quarantinedAt);
  const nowIso = now.toISOString();
  const due = mine.filter((e) => !e.nextAttemptAt || e.nextAttemptAt <= nowIso);
  const outletOf = (e: QueueEntry) => (typeof e.payload.outletId === 'string' ? e.payload.outletId : null);
  const visitsByOutlet = new Map<string, QueueEntry[]>();
  for (const e of mine) {
    const o = outletOf(e);
    if (e.type === 'visit' && o) visitsByOutlet.set(o, [...(visitsByOutlet.get(o) ?? []), e]);
  }
  const dueIds = new Set(due.map((e) => e.clientId));
  const eligible = due.filter((e) => {
    const o = outletOf(e);
    if (e.type !== 'order' || !o) return true;
    return (visitsByOutlet.get(o) ?? []).every((v) => dueIds.has(v.clientId));
  });
  const ordersByOutlet = new Map<string, QueueEntry[]>();
  for (const e of mine) {
    const o = outletOf(e);
    if (e.type === 'order' && o) ordersByOutlet.set(o, [...(ordersByOutlet.get(o) ?? []), e]);
  }
  // A visit is lifted to the earliest same-outlet order's position so it is always sent first.
  const sortKey = (e: QueueEntry): number => {
    const own = e.seq ?? NO_SEQ;
    const o = outletOf(e);
    if (e.type !== 'visit' || !o) return own;
    return Math.min(own, ...(ordersByOutlet.get(o) ?? []).map((x) => x.seq ?? NO_SEQ));
  };
  const rank = (e: QueueEntry) => (e.type === 'visit' ? 0 : 1);
  return eligible
    .sort((a, b) => sortKey(a) - sortKey(b) || rank(a) - rank(b) || bySeq(a, b))
    .slice(0, limit);
}

async function update(clientId: string, fn: (e: QueueEntry) => QueueEntry): Promise<QueueEntry | undefined> {
  const raw = await store.get(clientId);
  if (!raw) return undefined;
  const next = fn(normalize(raw));
  await store.put(next);
  return next;
}

/** Marks an in-flight batch. Counts as an attempt (undone by `releaseUnsent` when the request never reached the server's auth). */
export async function markSyncing(clientIds: string[]): Promise<void> {
  const at = new Date().toISOString();
  for (const id of clientIds) {
    await update(id, (e) => ({ ...e, status: 'SYNCING', attemptCount: e.attemptCount + 1, lastAttemptAt: at }));
  }
}

/** 401 / session pause: back to PENDING, attempt not counted, no error recorded. */
export async function releaseUnsent(clientIds: string[]): Promise<void> {
  for (const id of clientIds) {
    await update(id, (e) => (e.status === 'SYNCING' ? { ...e, status: 'PENDING', attemptCount: Math.max(0, e.attemptCount - 1) } : e));
  }
}

/** App start / session start: anything left SYNCING by a killed process had no ACK -> PENDING, re-sent with the SAME clientId. */
export async function releaseStaleSyncing(): Promise<number> {
  const s = getOfflineSession();
  const stale = (await readAll()).filter((e) => e.status === 'SYNCING' && ownedBy(e, s));
  // markSyncing counted an attempt, but a killed process never got a result:
  // give it back so repeated kills cannot walk an item to SYNC_MAX_ATTEMPTS.
  for (const e of stale) await update(e.clientId, (x) => ({ ...x, status: 'PENDING', attemptCount: Math.max(0, x.attemptCount - 1) }));
  return stale.length;
}

export async function markSynced(clientId: string, serverId?: string, paymentStatus?: PaymentStatus): Promise<void> {
  await update(clientId, (e) => ({ ...e, status: 'SYNCED', serverId: serverId ?? e.serverId, paymentStatus: paymentStatus ?? e.paymentStatus, lastError: undefined, nextAttemptAt: undefined }));
}

/** Cashier outcome learned online (GET /payments): updates only own SYNCED payment rows whose status changed. */
export async function applyHandoverStatus(serverId: string, status: PaymentStatus, rejectReason?: string | null): Promise<boolean> {
  const s = getOfflineSession();
  const row = (await readAll()).find((e) => e.type === 'payment' && e.serverId === serverId && ownedBy(e, s));
  if (!row || (row.paymentStatus === status && row.handoverRejectReason === (rejectReason ?? undefined))) return false;
  await update(row.clientId, (e) => ({ ...e, paymentStatus: status, handoverRejectReason: rejectReason ?? undefined }));
  return true;
}

export async function markFailed(clientId: string, error: QueueError): Promise<void> {
  await update(clientId, (e) => ({ ...e, status: 'FAILED', lastError: error, nextAttemptAt: undefined }));
}

export async function markConflict(clientId: string, error: QueueError): Promise<void> {
  await update(clientId, (e) => ({ ...e, status: 'CONFLICT', lastError: error, nextAttemptAt: undefined }));
}

/** Retryable outcome (RETRY / network / 5xx / timeout): back to PENDING with backoff, or FAILED/SYNC_MAX_ATTEMPTS at the cap. */
export async function markRetry(clientId: string, error?: QueueError, random?: () => number): Promise<void> {
  await update(clientId, (e) => {
    if (e.attemptCount >= MAX_SYNC_ATTEMPTS) {
      return {
        ...e,
        status: 'FAILED',
        nextAttemptAt: undefined,
        lastError: {
          code: 'SYNC_MAX_ATTEMPTS',
          message: `Sync failed after ${MAX_SYNC_ATTEMPTS} attempts`,
          details: { lastCode: error?.code ?? e.lastError?.code },
        },
      };
    }
    return {
      ...e,
      status: 'PENDING',
      lastError: error ?? e.lastError,
      nextAttemptAt: new Date(Date.now() + backoffDelayMs(e.attemptCount, random)).toISOString(),
    };
  });
}

/** Degraded-mode default wait when the server sent no Retry-After, and the ceiling for one wait. */
const DEFER_DEFAULT_MS = 60_000;
const DEFER_MAX_MS = BACKOFF_MAX_MS;

/**
 * F7 (TZ 12.5): the server refused temporarily (503 maintenance / 429). The
 * document stays PENDING with an unchanged attempt count (the markSyncing
 * attempt is given back), so it can never reach SYNC_MAX_ATTEMPTS, be
 * quarantined or rejected. Next try = Retry-After (+0..25% jitter), else 60 s.
 */
export async function deferRetry(clientIds: string[], error: QueueError, retryAfterMs?: number, random: () => number = Math.random): Promise<number> {
  const wait = Math.min(DEFER_MAX_MS, Math.max(retryAfterMs ?? DEFER_DEFAULT_MS, 1_000));
  const delay = Math.min(DEFER_MAX_MS, Math.round(wait * (1 + random() * 0.25)));
  const nextAttemptAt = new Date(Date.now() + delay).toISOString();
  for (const id of clientIds) {
    await update(id, (e) => (e.status === 'SYNCING' ? { ...e, status: 'PENDING', attemptCount: Math.max(0, e.attemptCount - 1), lastError: error, nextAttemptAt } : e));
  }
  return delay;
}

/** Today's entries of one type that exist for the agent (everything except FAILED) — offline source of Home/Route/Report "today" figures. */
export async function todayByType(type: SyncDocType): Promise<QueueEntry[]> {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  return (await listAll()).filter((e) => e.type === type && e.status !== 'FAILED' && e.createdAt.startsWith(todayPrefix));
}

/**
 * Drops SYNCED rows from a previous day, nothing else. PENDING / SYNCING /
 * FAILED / CONFLICT are never pruned regardless of age or storage pressure —
 * they leave only via ACK, `discardFailedItem` or `resolveConflictResubmit`.
 */
export async function pruneOld(): Promise<void> {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const stale = (await readAll()).filter((e) => e.status === 'SYNCED' && !e.createdAt.startsWith(todayPrefix));
  await Promise.all(stale.map((e) => db.queue.delete(e.clientId)));
}

// ---- selectors / helpers for the screens -------------------------------

export type QueueCounts = Record<QueueStatus, number> & { unsynced: number };

/** Current user's counts per status; `unsynced` = PENDING+SYNCING+FAILED+CONFLICT. */
export async function countByStatus(): Promise<QueueCounts> {
  const counts: QueueCounts = { PENDING: 0, SYNCING: 0, SYNCED: 0, FAILED: 0, CONFLICT: 0, unsynced: 0 };
  for (const e of await listAll()) {
    counts[e.status] += 1;
    if (UNSYNCED_STATUSES.includes(e.status)) counts.unsynced += 1;
  }
  return counts;
}

/** Unsynced documents of ALL owners on this device — the logout guard (a foreign user's unsent work also blocks the wipe). */
export async function unsyncedCountAllOwners(): Promise<number> {
  return (await readAll()).filter((e) => UNSYNCED_STATUSES.includes(e.status)).length;
}

/** FAILED + CONFLICT items of the current user ("Needs attention"). */
export async function listNeedsAttention(): Promise<QueueEntry[]> {
  return (await listAll())
    .filter((e) => e.status === 'FAILED' || e.status === 'CONFLICT')
    .sort(bySeq);
}

async function ownEntry(clientId: string): Promise<QueueEntry> {
  const e = (await listAll()).find((x) => x.clientId === clientId);
  if (!e) throw new QueueItemStateError('NOT_FOUND', `Queue item ${clientId} not found`);
  return e;
}

/**
 * Explicit user discard of a document the server did NOT accept (FAILED or
 * CONFLICT, no serverId). Anything else throws; nothing is ever discarded
 * implicitly.
 */
export async function discardFailedItem(clientId: string): Promise<void> {
  const e = await ownEntry(clientId);
  if ((e.status !== 'FAILED' && e.status !== 'CONFLICT') || e.serverId) {
    throw new QueueItemStateError('NOT_DISCARDABLE', `Queue item ${clientId} is ${e.status}; only unaccepted FAILED/CONFLICT items can be discarded`);
  }
  await db.queue.delete(clientId);
}

interface PriceChangedDetails {
  lines: { lineIndex: number; productId: string; packagingId: string; expectedUnitPrice: string; serverUnitPrice: string }[];
  expectedTotal: string;
  serverTotal: string;
}

/**
 * CONFLICT/PRICE_CHANGED -> user confirmed the server's new total (the UI
 * MUST show `lastError.details.serverTotal` and ask first; prices are never
 * swapped silently). Rewrites each conflicting line's `expectedUnitPrice` to
 * the server's price and returns the item to PENDING for a fresh send.
 * The SAME clientId is kept on purpose: a CONFLICT is returned before the
 * server creates anything, so no server record exists under that id and the
 * idempotency key is still free; keeping it makes any accidental double
 * submit still dedupe.
 */
export async function resolveConflictResubmit(clientId: string): Promise<{ expectedTotal: string; serverTotal: string }> {
  const e = await ownEntry(clientId);
  const details = e.lastError?.details as PriceChangedDetails | undefined;
  const lines = e.payload.lines as Record<string, unknown>[] | undefined;
  if (e.status !== 'CONFLICT' || e.lastError?.code !== 'PRICE_CHANGED' || e.type !== 'order' || !details?.lines || !Array.isArray(lines) || e.serverId) {
    throw new QueueItemStateError('NOT_RESOLVABLE', `Queue item ${clientId} is not a PRICE_CHANGED order conflict`);
  }
  const nextLines = lines.map((l) => ({ ...l }));
  for (const d of details.lines) {
    const line = nextLines[d.lineIndex];
    if (!line || line.productId !== d.productId || line.packagingId !== d.packagingId) {
      throw new QueueItemStateError('NOT_RESOLVABLE', `Conflict line ${d.lineIndex} does not match the queued order`);
    }
    line.expectedUnitPrice = d.serverUnitPrice;
  }
  await update(clientId, (x) => ({
    ...x,
    status: 'PENDING',
    payload: { ...x.payload, lines: nextLines },
    attemptCount: 0,
    nextAttemptAt: undefined,
    lastError: undefined,
  }));
  return { expectedTotal: details.expectedTotal, serverTotal: details.serverTotal };
}

export interface PendingExport {
  exportedAt: string;
  userId: string | null;
  companyId: string | null;
  /** True for the quarantine export: the file holds data of an UNKNOWN owner. */
  unknownOwner?: boolean;
  items: {
    clientId: string;
    type: SyncDocType;
    status: QueueStatus;
    createdAt: string;
    payload: Record<string, unknown>;
    lastError?: QueueError;
  }[];
}

function toExportItems(entries: QueueEntry[]): PendingExport['items'] {
  return entries
    .filter((e) => UNSYNCED_STATUSES.includes(e.status))
    .sort(bySeq)
    .map((e) => ({ clientId: e.clientId, type: e.type, status: e.status, createdAt: e.createdAt, payload: e.payload, lastError: e.lastError }));
}

/**
 * TZ 8.1 local recovery path: JSON of the CURRENT user's documents the server
 * has not accepted (PENDING/SYNCING/FAILED/CONFLICT). Other owners' documents
 * are never exported (no 'all' scope). The caller hands the string to a
 * download/share action; it is plaintext by design.
 */
export async function exportPendingToJson(): Promise<string> {
  const s = getOfflineSession();
  const out: PendingExport = { exportedAt: new Date().toISOString(), userId: s?.userId ?? null, companyId: s?.companyId ?? null, items: toExportItems(await listAll()) };
  return JSON.stringify(out, null, 2);
}

// ---- quarantine of ownerless pre-v3 rows (TZ 8.1 / 11.3) ----------------

/**
 * Ownerless (pre-v3) rows. NEVER pushed, never listed as anybody's work.
 * On a shared device we cannot know who created them, so nobody inherits them
 * implicitly; they are only exportable or explicitly discardable.
 */
export async function listQuarantined(): Promise<QueueEntry[]> {
  if (!getOfflineSession()) return [];
  return (await readAll()).filter((e) => !e.userId).sort(bySeq);
}

/** Export of quarantined rows: the file contains data of UNKNOWN owner (`unknownOwner: true`). */
export async function exportQuarantinedToJson(): Promise<string> {
  const s = getOfflineSession();
  const out: PendingExport = {
    exportedAt: new Date().toISOString(),
    userId: s?.userId ?? null,
    companyId: s?.companyId ?? null,
    unknownOwner: true,
    items: toExportItems(await listQuarantined()),
  };
  return JSON.stringify(out, null, 2);
}

/** Explicit user discard (UI confirms first) of one quarantined row. Owned rows are untouched. */
export async function discardQuarantinedItem(clientId: string): Promise<void> {
  const e = (await listQuarantined()).find((x) => x.clientId === clientId);
  if (!e) throw new QueueItemStateError('NOT_FOUND', `Quarantined item ${clientId} not found`);
  await db.queue.delete(clientId);
}

/** Unsynced rows the current user is answerable for on logout: own + quarantined (foreign owners' are untouched and not counted). */
export async function unsyncedCountForLogout(): Promise<number> {
  const s = getOfflineSession();
  return (await readAll()).filter((e) => UNSYNCED_STATUSES.includes(e.status) && (!e.userId || ownedBy(e, s))).length;
}

/** Force-logout discard: deletes ONLY the current user's own rows. Foreign/quarantined rows stay. */
export async function deleteOwnEntries(): Promise<void> {
  const s = getOfflineSession();
  const mine = (await readAll()).filter((e) => ownedBy(e, s));
  await Promise.all(mine.map((e) => db.queue.delete(e.clientId)));
}

/** Rows that must survive a logout wipe (anyone's, incl. quarantined). */
export async function queueRowCount(): Promise<number> {
  return db.queue.count();
}

// ---- revoked-session quarantine (ADR-022, TZ 8.4 "agent revoked") ---------

/**
 * Session revoked by the server: the owner's unsynced rows are quarantined in
 * place (owner tag kept, so no other user ever sees them; never pushed) and the
 * owner's already-ACKed SYNCED history is dropped. Idempotent. Runs BEFORE the
 * cache wipe so a crash in between never leaves pushable rows without a wipe.
 */
export async function quarantineOwnerEntries(owner: OfflineSession): Promise<number> {
  const mine = (await readAll()).filter((e) => ownedBy(e, owner));
  const now = new Date().toISOString();
  let quarantined = 0;
  for (const e of mine) {
    if (e.status === 'SYNCED') {
      await db.queue.delete(e.clientId);
    } else if (!e.quarantinedAt) {
      await store.put({ ...e, quarantinedAt: now });
      quarantined += 1;
    }
  }
  return quarantined;
}

/** Current user's OWN quarantined rows (after a block was lifted and they signed in again). */
export async function listOwnQuarantined(): Promise<QueueEntry[]> {
  return (await listAll()).filter((e) => !!e.quarantinedAt && e.status !== 'SYNCED').sort(bySeq);
}

/** Explicit, confirmed re-enable of the current user's own quarantined rows: they become ordinary again and are pushed under their own identity (ADR-022 ownership check still applies). */
export async function releaseOwnQuarantine(): Promise<number> {
  const rows = await listOwnQuarantined();
  for (const e of rows) {
    const { quarantinedAt: _q, ...rest } = e;
    void _q;
    await store.put(rest as QueueEntry);
  }
  return rows.length;
}

/** Revoked owner's quarantined rows (no session exists at this point, so the owner is passed explicitly). */
export async function listRevokedFor(owner: OfflineSession): Promise<QueueEntry[]> {
  return (await readAll()).filter((e) => ownedBy(e, owner) && !!e.quarantinedAt).sort(bySeq);
}

export async function exportRevokedToJson(owner: OfflineSession): Promise<string> {
  const out: PendingExport = {
    exportedAt: new Date().toISOString(),
    userId: owner.userId,
    companyId: owner.companyId,
    items: toExportItems(await listRevokedFor(owner)),
  };
  return JSON.stringify(out, null, 2);
}

/** Explicit, UI-confirmed discard of the revoked owner's quarantined rows only. */
export async function discardRevokedFor(owner: OfflineSession): Promise<void> {
  const rows = await listRevokedFor(owner);
  await Promise.all(rows.map((e) => db.queue.delete(e.clientId)));
}

function creatorIdOf(e: QueueEntry): string | null {
  for (const k of ['agentId', 'userId', 'createdBy'] as const) {
    const v = e.payload[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Pre-v3 documents carry no owner. They are NEVER adopted by whoever signs in
 * first (shared device: that would push A's cash under B's identity). A row is
 * claimed only if its payload names the creating agent and that is the current
 * user; everything else stays ownerless = quarantined.
 */
export async function claimLegacyEntries(session: OfflineSession): Promise<{ claimed: number; quarantined: number }> {
  const legacy = (await readAll()).filter((e) => !e.userId);
  let claimed = 0;
  for (const e of legacy) {
    if (creatorIdOf(e) === session.userId) {
      await store.put({ ...e, userId: session.userId, companyId: session.companyId });
      claimed += 1;
    }
  }
  return { claimed, quarantined: legacy.length - claimed };
}

export const queueRepository = {
  enqueue,
  listAll,
  listAllOwners,
  listPending,
  listPushable,
  markSyncing,
  releaseUnsent,
  releaseStaleSyncing,
  markSynced,
  applyHandoverStatus,
  markFailed,
  markConflict,
  markRetry,
  deferRetry,
  todayByType,
  pruneOld,
  countByStatus,
  unsyncedCountAllOwners,
  listNeedsAttention,
  discardFailedItem,
  resolveConflictResubmit,
  exportPendingToJson,
  claimLegacyEntries,
  listQuarantined,
  exportQuarantinedToJson,
  discardQuarantinedItem,
  unsyncedCountForLogout,
  deleteOwnEntries,
  queueRowCount,
  quarantineOwnerEntries,
  listOwnQuarantined,
  releaseOwnQuarantine,
  listRevokedFor,
  exportRevokedToJson,
  discardRevokedFor,
};
