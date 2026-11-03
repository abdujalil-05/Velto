import { describe, expect, it } from 'vitest';
import type { QueueEntry } from './queue';
import { attentionCount, isRejectedHandover, needsAttention, entryDisplayName, exportFileName, localizedError, parsePriceChanged, sortQueueForScreen } from './queue-view';

function e(over: Partial<QueueEntry>): QueueEntry {
  return { clientId: 'x', type: 'order', status: 'PENDING', payload: {}, createdAt: '2026-01-01T00:00:00Z', schemaVersion: 1, attemptCount: 0, ...over };
}

describe('queue-view', () => {
  it('prefers the localized error message, falls back to uz message then code', () => {
    const err = { code: 'C', message: 'uz-msg', messages: { uz: 'uz-msg', ru: 'ru-msg', en: 'en-msg' } };
    expect(localizedError(err, 'ru')).toBe('ru-msg');
    expect(localizedError({ code: 'C', message: 'uz-msg' }, 'en')).toBe('uz-msg');
    expect(localizedError({ code: 'C', message: '' }, 'en')).toBe('C');
    expect(localizedError(undefined, 'en')).toBeNull();
  });

  it('parses PRICE_CHANGED only for CONFLICT orders with complete details', () => {
    const details = { lines: [{ lineIndex: 0, productId: 'p', expectedUnitPrice: '10', serverUnitPrice: '12' }], expectedTotal: '10', serverTotal: '12' };
    const c = e({ status: 'CONFLICT', lastError: { code: 'PRICE_CHANGED', message: 'm', details } });
    expect(parsePriceChanged(c)).toMatchObject({ serverTotal: '12', expectedTotal: '10' });
    expect(parsePriceChanged({ ...c, status: 'FAILED' })).toBeNull();
    expect(parsePriceChanged({ ...c, lastError: { code: 'STOCK', message: 'm', details } })).toBeNull();
    expect(parsePriceChanged({ ...c, lastError: { code: 'PRICE_CHANGED', message: 'm', details: { lines: [] } } })).toBeNull();
  });

  it('resolves customer name for orders/payments and outlet name for visits', () => {
    const customers = [{ id: 'c1', name: 'Mijoz' }];
    const outlets = [{ id: 'o1', name: 'Do‘kon' }];
    expect(entryDisplayName(e({ payload: { customerId: 'c1' } }), customers, outlets)).toBe('Mijoz');
    expect(entryDisplayName(e({ type: 'visit', payload: { outletId: 'o1' } }), customers, outlets)).toBe('Do‘kon');
    expect(entryDisplayName(e({ payload: { customerId: 'zz' } }), customers, outlets)).toBeNull();
  });

  it('sorts conflicts, failed, pending, synced; counts failed+conflict as attention', () => {
    const rows = sortQueueForScreen([
      e({ clientId: 's', status: 'SYNCED' }),
      e({ clientId: 'p', status: 'PENDING' }),
      e({ clientId: 'f', status: 'FAILED' }),
      e({ clientId: 'c', status: 'CONFLICT' }),
    ]);
    expect(rows.map((r) => r.clientId)).toEqual(['c', 'f', 'p', 's']);
    expect(attentionCount({ failedCount: 2, conflictCount: 3 })).toBe(5);
  });

  it('builds a filesystem-safe export name', () => {
    expect(exportFileName(new Date('2026-01-02T03:04:05.678Z'))).toBe('velto-unsynced-2026-01-02T03-04-05-678Z.json');
  });

  it('treats a cashier-rejected payment as needs-attention and sorts it first', () => {
    const rejected = e({ clientId: 'r', type: 'payment', status: 'SYNCED', paymentStatus: 'REJECTED', createdAt: '2026-01-03T00:00:00Z' });
    const pending = e({ clientId: 'p', type: 'payment', status: 'SYNCED', paymentStatus: 'PENDING_HANDOVER' });
    const waiting = e({ clientId: 'w', status: 'PENDING', createdAt: '2026-01-02T00:00:00Z' });
    expect(isRejectedHandover(rejected)).toBe(true);
    expect(needsAttention(rejected)).toBe(true);
    expect(needsAttention(pending)).toBe(false);
    expect(sortQueueForScreen([pending, waiting, rejected]).map((x) => x.clientId)).toEqual(['r', 'w', 'p']);
  });
});
