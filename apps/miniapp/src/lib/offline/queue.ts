import type { PaymentStatus } from '@/lib/api/payments';
import type { SyncDocType } from '@/lib/api/sync';
import { db, QUEUE_SEQ_KEY } from './db';
import { EncryptedStore, type RowCodec } from './encrypted-store';
import { getOfflineSession, NoOfflineSessionError, type OfflineSession } from './session';
import { publishStorageStatus } from './storage-budget';
import { assertNoForeignLegacy, assertNoLegacyPayments, assertVaultReady, countDeviceKeyPaymentRows, isVaultReadyFor, openWithVault, sealWithVault, UK_FORMAT, VaultUnavailableError } from './vault';

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
    readonly code: 'NOT_FOUND' | 'NOT_DISCARDABLE' | 'NOT_RESOLVABLE' | 'CLIENT_ID_IN_USE' | 'CLIENT_ID_FOREIGN',
    message: string,
  ) {
    super(message);
    this.name = 'QueueItemStateError';
  }
}

/**
 * EVERY queue row (order, visit, payment) is encrypted under the owner's vault key (vault.ts) at write time.
 * A write while the vault is not ready for the owner THROWS (never a device-key fallback). A vault row is read
 * only while the vault is ready for its owner; otherwise it is skipped (locked), never dropped. Rows still under
 * the shared device key are legacy: read only for the signed-in owner; another user's and every ownerless row
 * is never decrypted here (only detected from its plaintext owner columns, kept untouched).
 */
export const queueCodec: RowCodec<QueueEntry> = {
  async encode(e) {
    if (!e.userId || !e.companyId) throw new VaultUnavailableError();
    const blob = await sealWithVault({ userId: e.userId, companyId: e.companyId }, e.clientId, e);
    if (!blob) throw new VaultUnavailableError();
    return blob;
  },
  async decode(row) {
    const { userId, companyId, clientId } = row as unknown as { userId?: string; companyId?: string; clientId: string };
    // Ownerless row: no verifiable owner (payload fields are unauthenticated) -> never decrypted/listed/exported/pushed; kept untouched.
    if (!userId || !companyId) return {};
    if (row._enc.v !== UK_FORMAT) {
      const s = getOfflineSession();
      if (!s || userId !== s.userId || companyId !== s.companyId) return {};
      return null;
    }
    const value = await openWithVault<QueueEntry>({ userId, companyId }, clientId, row._enc);
    return value && value.clientId === clientId && value.userId === userId && value.companyId === companyId ? { value } : {};
  },
};

const store = new EncryptedStore<QueueEntry, string>(
  db.queue as never,
  ['clientId', 'type', 'status', 'createdAt', 'userId', 'companyId', 'seq'],
  ['seq'],
  queueCodec,
);

const NO_SEQ = Number.MAX_SAFE_INTEGER;
/** FIFO comparator: seq, then createdAt, then clientId (legacy rows without seq sort last, stably). */
function bySeq(a: QueueEntry, b: QueueEntry): number {
  return (a.seq ?? NO_SEQ) - (b.seq ?? NO_SEQ) || a.createdAt.localeCompare(b.createdAt) || a.clientId.localeCompare(b.clientId);
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
export interface EnqueueItem {
  type: SyncDocType;
  payload: Record<string, unknown>;
  /** Stable per-document id, created ONCE when the form opens. A repeat call with the same id is a no-op. */
  clientId?: string;
}

/**
 * Atomic multi-document write (order + its visit): ONE Dexie transaction, so a failure leaves neither.
 * Idempotent by clientId: an id already in the queue is not written again (double-click / retry after a
 * failed UI step cannot create a second document). Returns the clientIds in input order.
 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export async function enqueueMany(items: EnqueueItem[]): Promise<string[]> {
  const session = getOfflineSession();
  if (!session) throw new NoOfflineSessionError();
  // No device-key documents: without the owner's vault key nothing (order, visit, payment) is created at all,
  // and the caller keeps the form data. Another user's legacy device-key rows also stop new work (see vault.ts).
  assertVaultReady(session);
  await assertNoForeignLegacy(session);
  if (items.some((i) => i.type === 'payment')) await assertNoLegacyPayments();
  const createdAt = new Date().toISOString();
  const entries: QueueEntry[] = items.map((i) => {
    const clientId = i.clientId ?? crypto.randomUUID();
    return {
      clientId,
      type: i.type,
      status: 'PENDING',
      payload: { ...i.payload, clientId },
      createdAt,
      schemaVersion: QUEUE_SCHEMA_VERSION,
      attemptCount: 0,
      userId: session.userId,
      companyId: session.companyId,
    };
  });
  // Re-submit with an existing clientId: identical payload -> no-op; different payload while still unsent
  // (PENDING/FAILED) -> payload replaced in place (same clientId/seq); already sent/decided -> explicit error;
  // other owner's row -> explicit error. Never silently drops a change.
  const mode: ('new' | 'skip' | 'update')[] = [];
  const prior = new Map<string, QueueEntry>();
  for (const e of entries) {
    const raw = await db.queue.get(e.clientId);
    if (!raw) {
      mode.push('new');
      continue;
    }
    const existing = await store.get(e.clientId);
    if (!existing || existing.userId !== session.userId || existing.companyId !== session.companyId) {
      throw new QueueItemStateError('CLIENT_ID_FOREIGN', 'clientId belongs to another owner or is not readable');
    }
    if (canonicalJson(existing.payload) === canonicalJson(e.payload) && existing.type === e.type) {
      mode.push('skip');
    } else if (existing.status === 'PENDING' || existing.status === 'FAILED') {
      prior.set(e.clientId, existing);
      mode.push('update');
    } else {
      throw new QueueItemStateError('CLIENT_ID_IN_USE', `clientId ${e.clientId} is ${existing.status}; its payload cannot be changed`);
    }
  }
  const toWrite = entries.map((e, i) => (mode[i] === 'update' ? { ...prior.get(e.clientId)!, payload: e.payload, status: 'PENDING' as const, nextAttemptAt: undefined } : e));
  // Crypto happens before the transaction (IndexedDB transactions auto-commit across non-IDB awaits).
  const rows = await store.encodeRows(toWrite);
  try {
    await db.transaction('rw', [db.meta, db.queue], async () => {
      let next = Math.max(((await db.meta.get(QUEUE_SEQ_KEY))?.value as number | undefined) ?? 0, (await db.queue.orderBy('seq').last())?.seq ?? 0);
      const fresh: Parameters<typeof db.queue.put>[0][] = [];
      for (const [idx, row] of rows.entries()) {
        const id = entries[idx]!.clientId;
        const raw = await db.queue.get(id);
        if (mode[idx] === 'skip') continue;
        if (mode[idx] === 'update') {
          if (!raw) continue;
          // Re-check inside the transaction: the row may have started syncing / changed owner since the pre-check.
          if ((raw.status !== 'PENDING' && raw.status !== 'FAILED') || raw.userId !== session.userId || raw.companyId !== session.companyId) {
            throw new QueueItemStateError('CLIENT_ID_IN_USE', `clientId ${id} is ${raw.status}; its payload cannot be changed`);
          }
          fresh.push({ ...row, seq: raw.seq } as never);
          continue;
        }
        if (raw) continue; // concurrent double-click: the other call already wrote it
        next += 1;
        fresh.push({ ...row, seq: next } as never);
      }
      if (fresh.length === 0) return;
      await db.meta.put({ key: QUEUE_SEQ_KEY, value: next });
      for (const row of fresh) await db.queue.put(row);
    });
  } catch (e) {
    if (isQuotaError(e)) {
      void publishStorageStatus().catch(() => {});
      throw new QueueQuotaError();
    }
    throw e;
  }
  void publishStorageStatus().catch(() => {});
  return entries.map((e) => e.clientId);
}

export async function enqueue(type: SyncDocType, payload: Record<string, unknown>, opts: { clientId?: string } = {}): Promise<string> {
  const [clientId] = await enqueueMany([{ type, payload, clientId: opts.clientId }]);
  return clientId!;
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
  const sess = getOfflineSession();
  // Payments are not pushed while the vault is down (updating a legacy row afterwards would have to be refused) nor
  // while any legacy device-key payment row is unresolved (pilot policy: financial use stays blocked until manual resolution).
  const paymentsOk = isVaultReadyFor(sess ?? { userId: '', companyId: '' }) && (await countDeviceKeyPaymentRows()) === 0;
  const mine = (await listAll()).filter((e) => e.status === 'PENDING' && !e.quarantinedAt && (e.type !== 'payment' || paymentsOk));
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
  try {
    await store.put(next);
  } catch (e) {
    // An EXISTING legacy device-key row (already readable with that key) may be updated in place while the vault
    // is not ready (status changes must not stall); it is moved into the vault by the next bring-up. New rows never take this path.
    const disk = e instanceof VaultUnavailableError ? await db.queue.get(clientId) : undefined;
    if (!disk || disk._enc?.v === UK_FORMAT || next.type === 'payment') throw e; // a PAYMENT is never rewritten under the device key
    await store.put(next, { deviceKey: true });
  }
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
  return db.queue.filter((r) => UNSYNCED_STATUSES.includes(r.status as QueueStatus)).count(); // plaintext status column: counts other owners' sealed rows without decrypting
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

/** PO decision: payments rejected as idempotency conflict/unverifiable are kept until the accountant reconciles them; never discardable on device. */
const RECONCILIATION_HOLD_CODES = ['PAYMENT_IDEMPOTENCY_CONFLICT', 'PAYMENT_IDEMPOTENCY_UNVERIFIABLE'];
export function isReconciliationHold(e: QueueEntry): boolean {
  return e.type === 'payment' && (e.status === 'FAILED' || e.status === 'CONFLICT') && !!e.lastError?.code && RECONCILIATION_HOLD_CODES.includes(e.lastError.code);
}

/**
 * Explicit user discard of a document the server did NOT accept (FAILED or
 * CONFLICT, no serverId). Anything else throws; nothing is ever discarded
 * implicitly.
 */
export async function discardFailedItem(clientId: string): Promise<void> {
  const e = await ownEntry(clientId);
  if (isReconciliationHold(e)) {
    throw new QueueItemStateError('NOT_DISCARDABLE', `Queue item ${clientId} is held for manual reconciliation (${e.lastError?.code}); it cannot be discarded`);
  }
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

/** Unsynced rows the current user is answerable for on logout: own only (foreign and ownerless rows are untouched and not counted). */
export async function unsyncedCountForLogout(): Promise<number> {
  const s = getOfflineSession();
  // Held payments never block logout: they stay in the queue under the owner's vault key (vault.ts).
  return (await readAll()).filter((e) => UNSYNCED_STATUSES.includes(e.status) && ownedBy(e, s) && !isReconciliationHold(e)).length;
}

/** Current user's held (reconciliation) payments. */
export async function listHeld(): Promise<QueueEntry[]> {
  return (await listAll()).filter(isReconciliationHold).sort(bySeq);
}

/** Legacy `sealed` row (per-row DEK format) migrated into the queue under the vault key: back as FAILED with its original lastError (still held, never pushed). Existing row with the same clientId wins. */
export async function restoreHeldEntry(entry: QueueEntry): Promise<void> {
  if (!entry.userId || !entry.companyId) throw new Error('ownerless held entry');
  assertVaultReady({ userId: entry.userId, companyId: entry.companyId });
  if (await db.queue.get(entry.clientId)) return;
  await store.put({ ...entry, status: 'FAILED', nextAttemptAt: undefined });
}

/**
 * Re-encrypts the owner's rows that are still under the device key (any type) to the owner's vault key,
 * one atomic row write each (a kill in between leaves the old, still readable row). Needs the vault ready for
 * the owner. Used at logout (no network) and at login for legacy device-key payments/held rows.
 * Returns how many owner rows are still under the device key afterwards.
 */
export async function sealOwnRowsToVault(
  owner: OfflineSession,
  opts: { onlyPayments?: boolean } = {},
): Promise<{ moved: number; remaining: number; remainingPayments: number; remainingOther: number }> {
  const raw = (await db.queue.where('userId').equals(owner.userId).toArray()).filter(
    (r) => r.companyId === owner.companyId && r._enc?.v !== UK_FORMAT && (!opts.onlyPayments || r.type === 'payment'),
  );
  let moved = 0;
  let remaining = 0;
  let remainingPayments = 0;
  for (const r of raw) {
    const outcome = isVaultReadyFor(owner) ? await sealRowCas(r.clientId) : 'failed';
    if (outcome === 'moved') moved += 1;
    else if (outcome === 'failed') {
      remaining += 1;
      if (r.type === 'payment') remainingPayments += 1;
    } // 'gone': deleted/ACKed meanwhile - never resurrected
  }
  return { moved, remaining, remainingPayments, remainingOther: remaining - remainingPayments };
}

type CasOutcome = 'moved' | 'gone' | 'failed';

function sameBlob(a: { iv: Uint8Array; ct: ArrayBuffer } | undefined, b: { iv: Uint8Array; ct: ArrayBuffer } | undefined): boolean {
  if (!a || !b) return false;
  const eq = (x: ArrayLike<number>, y: ArrayLike<number>) => x.length === y.length && Array.prototype.every.call(x, (v: number, i: number) => v === y[i]);
  return eq(a.iv, b.iv) && eq(new Uint8Array(a.ct), new Uint8Array(b.ct));
}

/**
 * Compare-and-swap move of one device-key row to the vault key. All crypto happens OUTSIDE the IndexedDB
 * transaction (a WebCrypto await would auto-commit it); inside the rw transaction the row is re-read and
 * written only if it still carries the very ciphertext we sealed from (any ACK delete, status change or other
 * update since the read makes the CAS fail). One retry with a fresh read; a row that vanished is never recreated.
 */
async function sealRowCas(clientId: string): Promise<CasOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await db.queue.get(clientId);
    if (!before) return 'gone';
    if (before._enc?.v === UK_FORMAT) return 'moved';
    let entry: QueueEntry | undefined;
    let encoded: (typeof before)[];
    try {
      entry = await store.get(clientId);
      if (!entry) return 'failed'; // unreadable under the device key: left untouched
      encoded = (await store.encodeRows([entry], true)) as unknown as (typeof before)[];
    } catch {
      return 'failed';
    }
    let written: { iv: Uint8Array; ct: ArrayBuffer } | undefined;
    try {
      const swapped = await db.transaction('rw', db.queue, async () => {
        const now = await db.queue.get(clientId);
        if (!now) return 'gone' as const;
        if (now.status !== before.status || !sameBlob(now._enc, before._enc)) return 'changed' as const;
        await db.queue.put(encoded[0]!);
        written = (await db.queue.get(clientId))?._enc; // exact bytes on disk from our write, read in the same transaction
        return 'moved' as const;
      });
      if (swapped === 'gone') return swapped;
      if (swapped === 'moved') return (await verifiedOrRolledBack(clientId, entry, before, written)) ? 'moved' : 'failed';
    } catch {
      return 'failed'; // IndexedDB error / quota / aborted transaction: the single-row write is atomic, the original row is intact
    }
  }
  return 'failed';
}

/** The legacy copy is only given up after the new ciphertext was read back and decrypted to the same entry; otherwise the original raw row is restored ONLY if the row on disk is still exactly the blob we wrote (CAS) - a legitimate concurrent update is never undone. */
async function verifiedOrRolledBack(clientId: string, entry: QueueEntry, original: Parameters<typeof db.queue.put>[0], written: { iv: Uint8Array; ct: ArrayBuffer } | undefined): Promise<boolean> {
  const back = await store.get(clientId).catch(() => undefined);
  if (back && JSON.stringify(back) === JSON.stringify(entry)) return true;
  await db
    .transaction('rw', db.queue, async () => {
      const now = await db.queue.get(clientId);
      if (now && sameBlob(now._enc, written)) await db.queue.put(original);
    })
    .catch(() => {});
  return false;
}

/**
 * Server-confirmed resolution of a held payment: removes ONLY that exact
 * clientId, and only while it is still a held row of the current user. Never
 * creates or resends a payment.
 */
export async function removeResolvedHeld(clientId: string): Promise<boolean> {
  const e = (await listAll()).find((x) => x.clientId === clientId);
  if (!e || !isReconciliationHold(e)) return false;
  await db.queue.delete(clientId);
  return true;
}

/**
 * Force-logout cleanup: deletes ONLY the current user's own rows the server has already ACKed (SYNCED).
 * Unaccepted work (PENDING/SYNCING/FAILED/CONFLICT) of any type is NEVER destroyed by logout: it stays
 * encrypted under the owner's key and returns on their next login (same clientId -> server dedupes).
 * Explicit destruction is only per-item discard or the separate emergency wipe. Foreign/quarantined rows stay.
 */
export async function deleteOwnEntries(): Promise<void> {
  const s = getOfflineSession();
  // A PAYMENT not confirmed synced by the server is never deleted (PO criterion): it stays in the queue (vault-encrypted,
  // owner-scoped) and is restored on the owner's next login under the same clientId, so server idempotency dedups a re-send.
  const mine = (await readAll()).filter((e) => ownedBy(e, s) && e.status === 'SYNCED');
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
      try {
        await store.put({ ...e, quarantinedAt: now });
        quarantined += 1;
      } catch (err) {
        // A payment cannot be rewritten without its vault key; it is never pushed without a session anyway. Row untouched.
        if (!(err instanceof VaultUnavailableError)) throw err;
      }
    }
  }
  return quarantined;
}

/** Rows of one owner still on the device, counted from plaintext owner columns only (works while the vault is locked; nothing is decrypted). */
export async function countOwnRows(owner: OfflineSession): Promise<number> {
  return db.queue.where('userId').equals(owner.userId).filter((r) => r.companyId === owner.companyId).count();
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

export const queueRepository = {
  enqueue,
  enqueueMany,
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
  isReconciliationHold,
  resolveConflictResubmit,
  exportPendingToJson,
  unsyncedCountForLogout,
  listHeld,
  sealOwnRowsToVault,
  restoreHeldEntry,
  removeResolvedHeld,
  deleteOwnEntries,
  queueRowCount,
  quarantineOwnerEntries,
  listOwnQuarantined,
  releaseOwnQuarantine,
  listRevokedFor,
  countOwnRows,
  exportRevokedToJson,
  discardRevokedFor,
};
