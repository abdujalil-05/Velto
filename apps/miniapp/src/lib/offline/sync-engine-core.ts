import { pullSync, pushSync } from '@/lib/api/sync';
import { applyPull, getCursor } from './repository';
import { queueRepository } from './queue';
import { enforceStorageBudget } from './storage-budget';

/** Plain (non-React) sync primitives — kept separate from sync-engine.tsx so the provider component can layer translated toasts on top without this module needing `useTranslations`. */

export async function runPull(): Promise<void> {
  const since = await getCursor();
  const result = await pullSync(since);
  await applyPull(result);
  await queueRepository.pruneOld();
  await enforceStorageBudget();
}

export interface PushOutcome {
  accepted: number;
  rejected: number;
}

/** 10.3's per-request cap: at most 20 documents per `/sync/push` call. */
const PUSH_BATCH_SIZE = 20;
/** Upper bound on batches per cycle (4 × 20 = 80 docs) — keeps a long backlog from monopolising one cycle while still draining it in minutes, not hours. */
const MAX_BATCHES_PER_CYCLE = 4;

/**
 * 10.3: pushes PENDING documents in batches of 20, resolving each by
 * clientId. Returns zero counts (a no-op) when the queue is empty — callers
 * use this to decide whether a "synced" toast/backoff-reset is warranted.
 *
 * Loops rather than pushing a single batch: after a long offline stretch the
 * queue routinely holds far more than 20 documents, and one batch per
 * 30s-interval cycle meant a 100-document backlog took ~2.5 minutes of
 * connectivity to clear — connectivity a field agent may not keep that long.
 * Each batch is resolved before the next is read, so a mid-drain
 * disconnection just leaves the remainder PENDING for the next cycle
 * (replay is idempotent on clientId).
 */
export async function runPush(): Promise<PushOutcome> {
  const outcome: PushOutcome = { accepted: 0, rejected: 0 };

  for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch++) {
    const pending = await queueRepository.listPending(PUSH_BATCH_SIZE);
    if (pending.length === 0) break;

    const { results } = await pushSync(pending.map((e) => ({ type: e.type, clientId: e.clientId, payload: e.payload })));

    // A server response missing an entry for a pushed clientId leaves that
    // row PENDING; without this the next iteration would re-read the exact
    // same batch forever.
    let resolved = 0;
    for (const result of results) {
      switch (result.status) {
        case 'ACCEPTED':
        case 'DUPLICATE':
          await queueRepository.markSynced(result.clientId);
          outcome.accepted += 1;
          resolved += 1;
          break;
        case 'REJECTED':
          await queueRepository.markFailed(result.clientId, result.error ?? { code: 'SYNC_UNKNOWN_ERROR', message: 'Rejected' });
          outcome.rejected += 1;
          resolved += 1;
          break;
      }
    }

    if (resolved === 0 || pending.length < PUSH_BATCH_SIZE) break;
  }

  return outcome;
}
