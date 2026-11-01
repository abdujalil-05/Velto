import { describe, expect, it } from 'vitest';
import type { QueueEntry } from './queue';
import { checkDecimal, checkQty, divideExact, MONEY_SCALE, repeatLineQty } from './pricing';
import { precisionHint } from './queue-view';

function e(over: Partial<QueueEntry>): QueueEntry {
  return { clientId: 'x', type: 'order', status: 'FAILED', payload: {}, createdAt: '2026-01-01T00:00:00Z', schemaVersion: 1, attemptCount: 0, ...over };
}

describe('ADR-059 decimal helpers', () => {
  it('tiyin: 100.05 ok, 100.005 rejected, junk invalid', () => {
    expect(checkDecimal('100.05', MONEY_SCALE)).toBe('ok');
    expect(checkDecimal('100,5', MONEY_SCALE)).toBe('ok');
    expect(checkDecimal('100.005', MONEY_SCALE)).toBe('scale');
    expect(checkDecimal('1e3', MONEY_SCALE)).toBe('invalid');
  });

  it('qty × factor must stay ≤3dp', () => {
    expect(checkQty('0.125', '1.5')).toBe('baseScale'); // 0.1875
    expect(checkQty('1.111', '1.5')).toBe('baseScale'); // 1.6665
    expect(checkQty('1.5', '1.5')).toBe('ok');
    expect(checkQty('1.2345', '1')).toBe('qtyScale');
  });

  it('divideExact: no float artefacts, null when inexact', () => {
    expect(divideExact('10', '3')).toBeNull();
    expect(divideExact('12', '3')).toBe('4');
    expect(divideExact('1.5', '0.5')).toBe('3');
    expect(divideExact('0.3', '0.1')).toBe('3');
  });

  it('repeat line: exact -> same packaging, inexact -> base packaging, else manual', () => {
    const box = { id: 'box', qtyInBaseUnit: '3' };
    const base = { id: 'pc', qtyInBaseUnit: '1' };
    expect(repeatLineQty('9', 'box', [box, base])).toEqual({ packagingId: 'box', qty: '3' });
    expect(repeatLineQty('10', 'box', [box, base])).toEqual({ packagingId: 'pc', qty: '10' });
    expect(repeatLineQty('10', 'box', [box])).toBeNull();
  });
});

describe('precisionHint (queue failure display)', () => {
  it('server codes map to a hint and stay actionable', () => {
    expect(precisionHint(e({ lastError: { code: 'ORDER_QTY_PRECISION', message: 'm' } }))).toBe('qty');
    expect(precisionHint(e({ status: 'CONFLICT', lastError: { code: 'ORDER_PRICE_BELOW_MIN', message: 'm' } }))).toBe('price');
  });
  it('old float payloads are surfaced from the payload itself', () => {
    expect(precisionHint(e({ payload: { lines: [{ qty: 3.3333333333333335 }] } }))).toBe('qty');
    expect(precisionHint(e({ type: 'payment', payload: { amount: 100.005 } }))).toBe('amount');
    expect(precisionHint(e({ type: 'payment', payload: { amount: '100.05' } }))).toBeNull();
  });
  it('SYNC_VALIDATION_FAILED maxScale and HTTP_400 decimal places are recognised', () => {
    const v = (property: string) => e({ lastError: { code: 'SYNC_VALIDATION_FAILED', message: 'm', details: [{ property, constraints: { maxScale: 'x' } }] } });
    expect(precisionHint(v('amount'))).toBe('amount');
    expect(precisionHint(v('lines.0.qty'))).toBe('qty');
    expect(precisionHint(e({ type: 'payment', lastError: { code: 'HTTP_400', message: 'm', details: ['amount must have at most 2 decimal places'] } }))).toBe('amount');
  });
  it('non-failed items are not flagged', () => {
    expect(precisionHint(e({ status: 'PENDING', payload: { lines: [{ qty: 3.3333333333333335 }] } }))).toBeNull();
  });
});
