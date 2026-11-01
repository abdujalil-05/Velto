import { Prisma } from '@velto/database';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { MAX_MONEY } from '../validators/numeric-bounds';
import { MoneyResponseInterceptor, formatMoneyFields } from './money-json';

const D = (v: string | number) => new Prisma.Decimal(v);
const json = (v: unknown) => JSON.parse(JSON.stringify(formatMoneyFields(v)));

describe('B2 money JSON: exactly 2dp strings for allowlisted keys', () => {
  it('integer, zero, negative, fractional', () => {
    expect(json({ total: D(1500000), amount: D(0), balance: D('-150.5'), unitPrice: D('1500000.5'), lineTotal: D('0.1') })).toEqual({
      total: '1500000.00', amount: '0.00', balance: '-150.50', unitPrice: '1500000.50', lineTotal: '0.10',
    });
  });
  it('large value near MAX_MONEY is exact', () => {
    expect(json({ total: D('999999999999999.99'), cachedBalance: D(MAX_MONEY) })).toEqual({
      total: '999999999999999.99', cachedBalance: '1000000000000000.00',
    });
  });
  it('quantities, factors and percentages are unchanged', () => {
    expect(json({ qty: D('2.5'), onHand: D(10), qtyInBaseUnit: D('12'), vatRate: D(12), discountPct: D('7.5'), deliveredQty: D('1.250') })).toEqual({
      qty: '2.5', onHand: '10', qtyInBaseUnit: '12', vatRate: '12', discountPct: '7.5', deliveredQty: '1.25',
    });
  });
  it('nested arrays/objects, nulls, numbers (count/pct) untouched', () => {
    expect(json({ meta: { total: 3 }, items: [{ minPrice: null, lines: [{ price: D(5), qty: D(2) }] }], turnoverChangePct: 12.5 })).toEqual({
      meta: { total: 3 }, items: [{ minPrice: null, lines: [{ price: '5.00', qty: '2' }] }], turnoverChangePct: 12.5,
    });
  });
  it('values with more than 2 places are never rounded (avgCheck excluded)', () => {
    expect(json({ amount: D('1.005'), avgCheck: D('33.3333') })).toEqual({ amount: '1.005', avgCheck: '33.3333' });
  });
  it('pre-change stored string bodies (idempotent replay) are normalised; `current` only for Decimal', () => {
    expect(json({ total: '1500000', amount: '10.5', current: '5', buckets: { current: D(5) } })).toEqual({
      total: '1500000.00', amount: '10.50', current: '5', buckets: { current: '5.00' },
    });
  });
  it('interceptor maps the handler result; non-plain objects pass through', async () => {
    const buf = Buffer.from('x');
    const out = (await lastValueFrom(new MoneyResponseInterceptor().intercept({} as never, { handle: () => of({ total: D(1), file: buf }) }))) as { total: string; file: Buffer };
    expect(out.total).toBe('1.00');
    expect(out.file).toBe(buf);
  });
  it('opaque JSON columns (audit old/new, errorLog, entityKey) are never rewritten', () => {
    const raw = { price: '1500', amount: 7, nested: { total: '10', balance: '3' } };
    expect(json({ oldValue: raw, newValue: raw, errorLog: { total: '4' }, tombstones: [{ entityKey: { amount: '5' } }] })).toEqual({
      oldValue: raw, newValue: raw, errorLog: { total: '4' }, tombstones: [{ entityKey: { amount: '5' } }],
    });
  });
  it('pagination counts, Date, BigInt and nested money under allowlisted object keys', () => {
    const d = new Date(0);
    const out = formatMoneyFields({ meta: { total: 0, page: 1 }, at: d, big: 5n, amount: { total: D(2) } }) as Record<string, unknown>;
    expect(out.meta).toEqual({ total: 0, page: 1 });
    expect(out.at).toBe(d);
    expect(out.big).toBe(5n);
    expect(out.amount).toEqual({ total: '2.00' });
  });
});
