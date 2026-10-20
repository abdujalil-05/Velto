import type { PaymentStatus } from '@/lib/api/payments';
import type { QueueStatus } from './queue';

/**
 * Single source of truth for the four agent-facing document states (TZ 8.6),
 * shared by orders, payments and visits (they all live in the same queue).
 * Device-saved and server-accepted are always different, translated states.
 *
 *  deviceOnly      PENDING, never sent yet            "Faqat shu qurilmada"
 *  sendPending     SYNCING, or PENDING after a retry   "Yuborish kutilmoqda"
 *  serverAccepted  SYNCED (server ACK)                 "Server qabul qildi"
 *  needsAttention  FAILED / CONFLICT / cashier-REJECTED "E'tibor kerak"
 */
export type DocState = 'deviceOnly' | 'sendPending' | 'serverAccepted' | 'needsAttention';

/** Secondary reason shown next to the state label (Queue.* message keys). */
export type DocDetailKey = 'failed' | 'conflict' | 'handoverPending' | 'handoverPosted' | 'handoverRejected' | 'maintenance' | 'rateLimited' | 'busy';

export type DocBadgeVariant = 'secondary' | 'success' | 'destructive' | 'warning';

export interface DocStateView {
  state: DocState;
  variant: DocBadgeVariant;
  detailKey?: DocDetailKey;
}

export const DOC_STATES: readonly DocState[] = ['deviceOnly', 'sendPending', 'serverAccepted', 'needsAttention'];

/** F7: a PENDING doc held back by 503 maintenance / 429 — calm "waiting" state with the reason, never needs-attention. */
export function degradedDetail(lastErrorCode?: string): DocDetailKey | undefined {
  if (lastErrorCode === 'MAINTENANCE_READ_ONLY' || lastErrorCode === 'SERVICE_UNAVAILABLE') return 'maintenance';
  if (lastErrorCode === 'RATE_LIMITED') return 'rateLimited';
  if (lastErrorCode === 'SERVICE_BUSY') return 'busy';
  return undefined;
}

export function docStateView(status: QueueStatus, paymentStatus?: PaymentStatus, attemptCount = 0, lastErrorCode?: string): DocStateView {
  switch (status) {
    case 'SYNCED':
      // ADR-029: server-accepted is not cashier-accepted; debt is reduced only at POSTED.
      if (paymentStatus === 'PENDING_HANDOVER') return { state: 'serverAccepted', variant: 'warning', detailKey: 'handoverPending' };
      if (paymentStatus === 'REJECTED') return { state: 'needsAttention', variant: 'destructive', detailKey: 'handoverRejected' };
      if (paymentStatus === 'POSTED') return { state: 'serverAccepted', variant: 'success', detailKey: 'handoverPosted' };
      return { state: 'serverAccepted', variant: 'success' };
    case 'FAILED':
      return { state: 'needsAttention', variant: 'destructive', detailKey: 'failed' };
    case 'CONFLICT':
      return { state: 'needsAttention', variant: 'warning', detailKey: 'conflict' };
    case 'SYNCING':
      return { state: 'sendPending', variant: 'secondary' };
    default: {
      const detailKey = degradedDetail(lastErrorCode);
      if (detailKey) return { state: 'sendPending', variant: 'secondary', detailKey };
      return attemptCount > 0 ? { state: 'sendPending', variant: 'secondary' } : { state: 'deviceOnly', variant: 'secondary' };
    }
  }
}
