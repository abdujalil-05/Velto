import type { SyncDocType } from '@/lib/api/sync';
import { db } from './db';
import { EncryptedStore } from './encrypted-store';

/**
 * 10.3's PENDING/FAILED plus one addition, SYNCED: accepted/duplicate/
 * on-hold documents are marked SYNCED and kept until `pruneSynced` clears
 * them out (called after each successful pull), rather than deleted the
 * instant they're confirmed. This one `queue` table is deliberately the
 * single source both the sync badge's pending count and the Home/Route/
 * Report screens' offline "today" stats read from — 10.2's Dexie schema has
 * no separate table for historical orders/visits/payments (offline
 * reference data is deliberately reference+state only), so re-deriving
 * "what did I do today" from the one table already required for guaranteed
 * delivery avoids inventing a second local mirror with its own sync logic.
 */
export type QueueStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface QueueEntry {
  clientId: string;
  type: SyncDocType;
  status: QueueStatus;
  payload: Record<string, unknown>;
  createdAt: string;
  error?: { code: string; message: string };
}

const store = new EncryptedStore<QueueEntry, string>(db.queue as never, ['clientId', 'type', 'status', 'createdAt']);

/** Queues a document for guaranteed delivery — returns immediately, UI shows "saqlandi" without waiting on the network (10.3). `payload.clientId` is set to match so a resubmit is idempotent on the server too (Create*Dto.clientId). */
export async function enqueue(type: SyncDocType, payload: Record<string, unknown>): Promise<string> {
  const clientId = crypto.randomUUID();
  const entry: QueueEntry = {
    clientId,
    type,
    status: 'PENDING',
    payload: { ...payload, clientId },
    createdAt: new Date().toISOString(),
  };
  await store.put(entry);
  return clientId;
}

export async function listAll(): Promise<QueueEntry[]> {
  return store.toArray();
}

export async function listPending(limit = 20): Promise<QueueEntry[]> {
  const all = await store.toArray();
  return all
    .filter((e) => e.status === 'PENDING')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

export async function markSynced(clientId: string): Promise<void> {
  const entry = await store.get(clientId);
  if (!entry) return;
  await store.put({ ...entry, status: 'SYNCED' });
}

export async function markFailed(clientId: string, error: { code: string; message: string }): Promise<void> {
  const entry = await store.get(clientId);
  if (!entry) return;
  await store.put({ ...entry, status: 'FAILED', error });
}

/** Today's entries of a given type, PENDING or SYNCED (i.e. "things I actually did today", regardless of whether the server has confirmed yet) — the offline-first source for Home/Route/Report's "today" figures. */
export async function todayByType(type: SyncDocType): Promise<QueueEntry[]> {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const all = await store.toArray();
  return all.filter((e) => e.type === type && e.status !== 'FAILED' && e.createdAt.startsWith(todayPrefix));
}

/** Drops SYNCED/FAILED rows from a previous day — called after each successful pull so the queue table doesn't grow forever. PENDING rows are never pruned regardless of age (guaranteed delivery — 10.3's "asosiy tamoyil"). */
export async function pruneOld(): Promise<void> {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const all = await store.toArray();
  const stale = all.filter((e) => e.status !== 'PENDING' && !e.createdAt.startsWith(todayPrefix));
  await Promise.all(stale.map((e) => db.queue.delete(e.clientId)));
}

export const queueRepository = { enqueue, listAll, listPending, markSynced, markFailed, todayByType, pruneOld };
