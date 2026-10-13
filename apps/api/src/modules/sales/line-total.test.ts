import { Prisma } from '@velto/database';
import { describe, expect, it } from 'vitest';
import { calcLineTotal } from './line-total';

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
