import type { QueueEntry, QueueError } from './queue';
import { decimalScale, MONEY_SCALE, QTY_SCALE } from './pricing';

/**
 * Pure presentation logic for the queue / conflicts screen (TZ 8.4, 9.3):
 * kept free of React/Dexie so it is unit-testable and the components stay thin.
 */

/** Prefers the trilingual server message, then the Uzbek `message`, then the bare code. */
export function localizedError(err: QueueError | undefined, locale: string): string | null {
  if (!err) return null;
  const m = err.messages as Record<string, string> | undefined;
  return m?.[locale] || err.message || err.code || null;
}

export interface PriceChangedView {
  lines: { lineIndex: number; productId: string; expectedUnitPrice: string; serverUnitPrice: string }[];
  expectedTotal: string;
  serverTotal: string;
}

/** Defensive parse of CONFLICT/PRICE_CHANGED details; null when it is not a resolvable price conflict. */
export function parsePriceChanged(entry: QueueEntry): PriceChangedView | null {
  if (entry.status !== 'CONFLICT' || entry.lastError?.code !== 'PRICE_CHANGED' || entry.type !== 'order') return null;
  const d = entry.lastError.details as Partial<PriceChangedView> | undefined;
  if (!d || !Array.isArray(d.lines) || d.expectedTotal == null || d.serverTotal == null) return null;
  return { lines: d.lines, expectedTotal: String(d.expectedTotal), serverTotal: String(d.serverTotal) };
}

export interface NamedRef {
  id: string;
  name: string;
}

/** Customer (order/payment) or outlet (visit) display name from the local reference cache; null if unknown. */
export function entryDisplayName(entry: QueueEntry, customers: NamedRef[], outlets: NamedRef[]): string | null {
  const p = entry.payload as { customerId?: string; outletId?: string };
  if (entry.type === 'visit') return outlets.find((o) => o.id === p.outletId)?.name ?? null;
  return customers.find((c) => c.id === p.customerId)?.name ?? null;
}

/** A payment the cashier rejected: the server holds it, but it needs the agent's attention (with the reason). */
export function isRejectedHandover(e: QueueEntry): boolean {
  return e.type === 'payment' && e.status === 'SYNCED' && e.paymentStatus === 'REJECTED';
}

export function needsAttention(e: QueueEntry): boolean {
  return e.status === 'FAILED' || e.status === 'CONFLICT' || isRejectedHandover(e);
}

/** Needs-attention first (oldest first), then pending/syncing, SYNCED excluded from the actionable list. */
export function sortQueueForScreen(entries: QueueEntry[]): QueueEntry[] {
  const rank = (e: QueueEntry) => (e.status === 'CONFLICT' ? 0 : e.status === 'FAILED' ? 1 : isRejectedHandover(e) ? 1 : e.status === 'SYNCED' ? 3 : 2);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
}

export function attentionCount(counts: { failedCount: number; conflictCount: number }): number {
  return counts.failedCount + counts.conflictCount;
}

export function exportFileName(now: Date = new Date()): string {
  return `velto-unsynced-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

/** Browser download of a JSON string (plaintext by design — TZ 8.1 recovery path). */
export function downloadJson(json: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** PAYMENT_IDEMPOTENCY_CONFLICT: same clientId, different content. Terminal; user must cancel and enter a NEW payment (new clientId). */
export function isPaymentIdempotencyConflict(e: QueueEntry): boolean {
  return e.type === 'payment' && (e.status === 'FAILED' || e.status === 'CONFLICT') && e.lastError?.code === 'PAYMENT_IDEMPOTENCY_CONFLICT';
}

export type PrecisionHint = 'qty' | 'amount' | 'price';

const PRECISION_CODES: Record<string, PrecisionHint> = {
  ORDER_QTY_PRECISION: 'qty',
  ORDER_PRICE_BELOW_MIN: 'price',
};

/**
 * ADR-059: why an unaccepted FAILED/CONFLICT item needs a manual fix, from the server code
 * or (for old queued items sent before the rule) from the payload's own decimals.
 * Allowed action is always "cancel and re-enter" - the item is never auto-deleted or rounded.
 */
export function precisionHint(entry: QueueEntry): PrecisionHint | null {
  if (entry.status !== 'FAILED' && entry.status !== 'CONFLICT') return null;
  const byCode = entry.lastError?.code ? PRECISION_CODES[entry.lastError.code] : undefined;
  if (byCode) return byCode;
  const d = entry.lastError?.details;
  if (entry.lastError?.code === 'SYNC_VALIDATION_FAILED' && Array.isArray(d)) {
    for (const item of d as { property?: unknown; constraints?: { maxScale?: unknown } }[]) {
      if (item?.constraints?.maxScale == null) continue;
      const prop = String(item.property ?? '');
      if (/amount/i.test(prop)) return 'amount';
      if (/qty/i.test(prop)) return 'qty';
      if (/price/i.test(prop)) return 'price';
    }
  }
  if (entry.lastError?.code === 'HTTP_400' && Array.isArray(d) && d.some((x) => typeof x === 'string' && /decimal places/i.test(x))) {
    if (entry.type === 'payment') return 'amount';
    if (entry.type === 'order') return 'qty';
  }
  const p = entry.payload as { amount?: unknown; lines?: { qty?: unknown }[] };
  if (entry.type === 'payment' && (typeof p.amount === 'number' || typeof p.amount === 'string') && decimalScale(p.amount) > MONEY_SCALE) return 'amount';
  if (entry.type === 'order' && Array.isArray(p.lines)) {
    const bad = p.lines.some((l) => (typeof l.qty === 'number' || typeof l.qty === 'string') && decimalScale(l.qty) > QTY_SCALE);
    if (bad) return 'qty';
  }
  return null;
}
