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

/** 10.3: pushes up to 20 PENDING documents, resolves each by clientId. Returns zero counts (a no-op) when the queue is empty — callers use this to decide whether a "synced" toast/backoff-reset is warranted. */
export async function runPush(): Promise<PushOutcome> {
  const pending = await queueRepository.listPending(20);
  if (pending.length === 0) return { accepted: 0, rejected: 0 };

  const { results } = await pushSync(pending.map((e) => ({ type: e.type, clientId: e.clientId, payload: e.payload })));

  const outcome: PushOutcome = { accepted: 0, rejected: 0 };
  for (const result of results) {
    switch (result.status) {
      case 'ACCEPTED':
      case 'DUPLICATE':
        await queueRepository.markSynced(result.clientId);
        outcome.accepted += 1;
        break;
      case 'REJECTED':
        await queueRepository.markFailed(result.clientId, result.error ?? { code: 'SYNC_UNKNOWN_ERROR', message: 'Rejected' });
        outcome.rejected += 1;
        break;
    }
  }
  return outcome;
}
