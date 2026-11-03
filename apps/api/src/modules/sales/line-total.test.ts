import { OrderStatus, Prisma } from '@velto/database';
import { describe, expect, it } from 'vitest';
import { calcLineTotal, deliveredLineTotal, effectiveLineTotal, orderTotal, type OrderLineAmounts } from './line-total';

describe('calcLineTotal', () => {
  it('qty × price with no discount and no VAT', () => {
    expect(calcLineTotal(3, '15000', 0, 0).toString()).toBe('45000');
  });

  it('applies discount then VAT multiplicatively', () => {
    // 2 × 10000 = 20000; −10% = 18000; +12% VAT = 20160
    expect(calcLineTotal('2', '10000', '10', '12').toString()).toBe('20160');
  });

  it('accepts Prisma.Decimal inputs and keeps fractional quantities exact', () => {
    const r = calcLineTotal(new Prisma.Decimal('1.5'), new Prisma.Decimal('333.33'), new Prisma.Decimal('0'), new Prisma.Decimal('12'));
    // 1.5 × 333.33 = 499.995; × 1.12 = 559.9944 (unrounded, column rounds on write)
    expect(r.toString()).toBe('559.9944');
  });

  it('avoids float drift (0.1 × 3)', () => {
    expect(calcLineTotal('0.1', '3', 0, 0).toString()).toBe('0.3');
  });

  it('100% discount yields zero', () => {
    expect(calcLineTotal(5, 1000, 100, 12).isZero()).toBe(true);
  });

  it('zero qty yields zero', () => {
    expect(calcLineTotal(0, 1000, 5, 12).isZero()).toBe(true);
  });
});

function line(qty: string, deliveredQty: string, unitPrice: string, discountPct: string, vatRate: string): OrderLineAmounts {
  return {
    qty: new Prisma.Decimal(qty),
    deliveredQty: new Prisma.Decimal(deliveredQty),
    unitPrice: new Prisma.Decimal(unitPrice),
    discountPct: new Prisma.Decimal(discountPct),
    vatRate: new Prisma.Decimal(vatRate),
    // snapshot as the Decimal(18,2) column stores it
    lineTotal: calcLineTotal(qty, unitPrice, discountPct, vatRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
  };
}

describe('deliveredLineTotal / effectiveLineTotal / orderTotal (F2.4)', () => {
  it('fully delivered line keeps the snapshot lineTotal exactly', () => {
    const l = line('3', '3', '999.99', '0', '12'); // 3359.9664 → 3359.97
    expect(deliveredLineTotal(l).toString()).toBe('3359.97');
  });

  it('partial line is recomputed from the snapshot and rounded half-up to 2dp', () => {
    // 1 × 999.99 × 1.12 = 1119.9888 → 1119.99
    expect(deliveredLineTotal(line('3', '1', '999.99', '0', '12')).toString()).toBe('1119.99');
    // 1 × 33333.33 × 0.9 × 1.12 = 33599.99664 → 33600
    expect(deliveredLineTotal(line('4', '1', '33333.33', '10', '12')).toString()).toBe('33600');
  });

  it('zero delivered → zero', () => {
    expect(deliveredLineTotal(line('5', '0', '1000', '0', '12')).isZero()).toBe(true);
  });

  it('DELIVERED and CLOSED use delivered amounts; other statuses use ordered snapshot', () => {
    const lines = [line('10', '4', '10000', '0', '12'), line('3', '1', '999.99', '0', '12')];
    for (const status of [OrderStatus.DELIVERED, OrderStatus.CLOSED]) {
      expect(orderTotal({ status, lines }).toString()).toBe('45919.99');
    }
    for (const status of [OrderStatus.DRAFT, OrderStatus.SUBMITTED, OrderStatus.CONFIRMED, OrderStatus.CANCELLED]) {
      expect(orderTotal({ status, lines }).toString()).toBe('115359.97');
      expect(effectiveLineTotal(status, lines[1]!).toString()).toBe('3359.97');
    }
  });
});
