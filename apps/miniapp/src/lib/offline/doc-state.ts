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
export type DocDetailKey = 'failed' | 'conflict' | 'handoverPending' | 'handoverPosted' | 'handoverRejected';

export type DocBadgeVariant = 'secondary' | 'success' | 'destructive' | 'warning';

export interface DocStateView {
  state: DocState;
  variant: DocBadgeVariant;
  detailKey?: DocDetailKey;
}

export const DOC_STATES: readonly DocState[] = ['deviceOnly', 'sendPending', 'serverAccepted', 'needsAttention'];

export function docStateView(status: QueueStatus, paymentStatus?: PaymentStatus, attemptCount = 0): DocStateView {
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
    default:
      return attemptCount > 0 ? { state: 'sendPending', variant: 'secondary' } : { state: 'deviceOnly', variant: 'secondary' };
  }
}
