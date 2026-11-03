import { fetchPaymentStatuses, PAYMENT_STATUSES_LIMIT } from '@/lib/api/payments';
import { queueRepository } from './queue';
import type { QueueEntry } from './queue';

export function isAwaitingHandover(e: QueueEntry): boolean {
  return e.type === 'payment' && e.paymentStatus === 'PENDING_HANDOVER';
}

/**
 * Online only: asks the server for the cashier's decision on every payment still awaiting handover,
 * in chunks of PAYMENT_STATUSES_LIMIT, and stores it on the queue row. Returns true if any row changed.
 */
export async function refreshHandoverDecisions(): Promise<boolean> {
  // Only rows with a serverId: PENDING_HANDOVER is set from the server ACK, so it always has one.
  const awaiting = (await queueRepository.listAll()).filter((e) => isAwaitingHandover(e) && e.serverId);
  let changed = false;
  for (let i = 0; i < awaiting.length; i += PAYMENT_STATUSES_LIMIT) {
    const chunk = awaiting.slice(i, i + PAYMENT_STATUSES_LIMIT);
    const rows = await fetchPaymentStatuses({ ids: chunk.map((e) => e.serverId as string) });
    for (const r of rows) {
      if (await queueRepository.applyHandoverStatus(r.id, r.status, r.handoverRejectReason)) changed = true;
    }
  }
  return changed;
}
