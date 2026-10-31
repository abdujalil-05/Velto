import { Prisma } from '@velto/database';
import { describe, expect, it } from 'vitest';
import { calcLineTotal, deliveredLineTotal } from './line-total';

/**
 * ADR-059 golden rounding table (TZ §6.6): line = qty × price × (1 − disc/100) × (1 + vat/100),
 * VAT exclusive, discount BEFORE VAT, rounded ONCE to 2dp HALF_UP (what Decimal(18,2) does on write).
 *
 * Every `expected` below was derived by hand (cross-checked with an independent Python decimal
 * script, 60-digit precision) and is NEVER computed with line-total.ts. `steps` documents the order
 * of operations. `qty` is the BASE quantity (packaging qty × qtyInBaseUnit is shown in the steps).
 */
const D = (v: string) => new Prisma.Decimal(v);
const round2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);

interface Case {
  name: string;
  qty: string;
  price: string;
  disc: string;
  vat: string;
  expected: string;
  steps: string;
}

const CASES: Case[] = [
  // --- x.xx4999 / x.xx5 / x.xx5001 boundary (no discount, no VAT) ---
  { name: 'x.xx4999 rounds down', qty: '1000.499', price: '0.01', disc: '0', vat: '0', expected: '10.00', steps: '1000.499 × 0.01 = 10.00499 -> 10.00' },
  { name: 'x.xx5 rounds UP (half-up, not banker)', qty: '1000.500', price: '0.01', disc: '0', vat: '0', expected: '10.01', steps: '1000.5 × 0.01 = 10.005 -> 10.01' },
  { name: 'x.xx5001 rounds up', qty: '1000.501', price: '0.01', disc: '0', vat: '0', expected: '10.01', steps: '1000.501 × 0.01 = 10.00501 -> 10.01' },
  // --- tiny prices / quantities ---
  { name: 'tiny 0.00499 -> 0.00', qty: '0.001', price: '4.99', disc: '0', vat: '0', expected: '0.00', steps: '0.001 × 4.99 = 0.00499 -> 0.00' },
  { name: 'tiny 0.005 -> 0.01', qty: '0.001', price: '5.00', disc: '0', vat: '0', expected: '0.01', steps: '0.001 × 5.00 = 0.005 -> 0.01' },
  { name: 'tiny 0.00501 -> 0.01', qty: '0.001', price: '5.01', disc: '0', vat: '0', expected: '0.01', steps: '0.001 × 5.01 = 0.00501 -> 0.01' },
  { name: 'tiny qty × tiny price -> 0.00', qty: '0.001', price: '0.01', disc: '0', vat: '0', expected: '0.00', steps: '0.001 × 0.01 = 0.00001 -> 0.00' },
  { name: 'tiny with VAT 12 -> 0.00', qty: '0.001', price: '0.01', disc: '0', vat: '12', expected: '0.00', steps: '0.00001 × 1.12 = 0.0000112 -> 0.00' },
  // --- VAT 15 / 12 boundaries (VAT applied after discount, on the net) ---
  { name: 'VAT 15: 0.345 -> 0.35', qty: '1', price: '0.30', disc: '0', vat: '15', expected: '0.35', steps: '0.30 × 1.15 = 0.345 -> 0.35' },
  { name: 'VAT 15: 1.495 -> 1.50', qty: '1', price: '1.30', disc: '0', vat: '15', expected: '1.50', steps: '1.30 × 1.15 = 1.495 -> 1.50' },
  { name: 'VAT 15: 2.415 -> 2.42', qty: '1', price: '2.10', disc: '0', vat: '15', expected: '2.42', steps: '2.10 × 1.15 = 2.415 -> 2.42' },
  { name: 'VAT 12: 4.9952 -> 5.00', qty: '1', price: '4.46', disc: '0', vat: '12', expected: '5.00', steps: '4.46 × 1.12 = 4.9952 -> 5.00' },
  { name: 'VAT 12 fractional qty exact', qty: '2.5', price: '3.30', disc: '0', vat: '12', expected: '9.24', steps: '2.5 × 3.30 = 8.25; × 1.12 = 9.24' },
  // --- 12.5% discount (exact binary-hostile fraction) ---
  { name: '12.5% disc: 0.875 -> 0.88', qty: '1', price: '1.00', disc: '12.5', vat: '0', expected: '0.88', steps: '1.00 × 0.875 = 0.875 -> 0.88' },
  { name: '12.5% disc: 0.525 -> 0.53', qty: '1', price: '0.60', disc: '12.5', vat: '0', expected: '0.53', steps: '0.60 × 0.875 = 0.525 -> 0.53' },
  { name: '12.5% disc: 2.275 -> 2.28', qty: '1', price: '2.60', disc: '12.5', vat: '0', expected: '2.28', steps: '2.60 × 0.875 = 2.275 -> 2.28' },
  { name: '12.5% disc then VAT 12 = 1.029', qty: '1', price: '1.05', disc: '12.5', vat: '12', expected: '1.03', steps: '1.05 × 0.875 = 0.91875; × 1.12 = 1.029 -> 1.03' },
  { name: '12.5% disc then VAT 15 = 100.625 half-up', qty: '1', price: '100.00', disc: '12.5', vat: '15', expected: '100.63', steps: '100 × 0.875 = 87.5; × 1.15 = 100.625 -> 100.63' },
  { name: '12.5% disc then VAT 15 = 100.6149375', qty: '1', price: '99.99', disc: '12.5', vat: '15', expected: '100.61', steps: '99.99 × 0.875 = 87.49125; × 1.15 = 100.6149375 -> 100.61' },
  { name: 'discount before VAT, not after (10% + 12%)', qty: '3', price: '33333.33', disc: '10', vat: '12', expected: '100799.99', steps: '3 × 33333.33 = 99999.99; × 0.9 = 89999.991; × 1.12 = 100799.98992 -> 100799.99' },
  // --- fractional qty / existing golden ---
  { name: 'fractional qty 0.333 × 1000', qty: '0.333', price: '1000.00', disc: '0', vat: '0', expected: '333.00', steps: '0.333 × 1000 = 333' },
  { name: 'fractional qty 0.333 × 1000 + VAT 12', qty: '0.333', price: '1000.00', disc: '0', vat: '12', expected: '372.96', steps: '333 × 1.12 = 372.96' },
  { name: 'fractional qty 1.5 × 333.33 + VAT 12', qty: '1.5', price: '333.33', disc: '0', vat: '12', expected: '559.99', steps: '1.5 × 333.33 = 499.995; × 1.12 = 559.9944 -> 559.99 (VAT applied BEFORE rounding)' },
  // --- packaging factor (base qty = packQty × qtyInBaseUnit, exact at 3dp) ---
  { name: 'packaging 3 boxes × 12 = 36 base', qty: '36', price: '1500.00', disc: '0', vat: '12', expected: '60480.00', steps: '3 × 12 = 36; 36 × 1500 = 54000; × 1.12 = 60480' },
  { name: 'packaging 0.5 box × 0.75 = 0.375 base', qty: '0.375', price: '1000.00', disc: '0', vat: '12', expected: '420.00', steps: '0.5 × 0.75 = 0.375; × 1000 = 375; × 1.12 = 420' },
  // --- large range (Decimal(18,2) upper end: 16 integer digits) ---
  { name: 'max price 9 999 999 999 999.99 untouched', qty: '1', price: '9999999999999.99', disc: '0', vat: '0', expected: '9999999999999.99', steps: 'qty 1, no disc/VAT' },
  { name: 'max price + VAT 12', qty: '1', price: '9999999999999.99', disc: '0', vat: '12', expected: '11199999999999.99', steps: '9999999999999.99 × 1.12 = 11199999999999.9888 -> 11199999999999.99' },
  { name: 'max price × qty 999 (18 significant digits)', qty: '999', price: '9999999999999.99', disc: '0', vat: '0', expected: '9989999999999990.01', steps: '999 × 9999999999999.99 = 9989999999999990.01' },
  { name: 'max price, 100% discount -> 0.00', qty: '1', price: '9999999999999.99', disc: '100', vat: '12', expected: '0.00', steps: '× (1 − 1) = 0' },
  { name: 'max price, 12.5% disc + VAT 15', qty: '1', price: '9999999999999.99', disc: '12.5', vat: '15', expected: '10062499999999.99', steps: '× 0.875 = 8749999999999.99125; × 1.15 = 10062499999999.9899375 -> 10062499999999.99' },
  { name: 'max price, 0.01% disc', qty: '1', price: '9999999999999.99', disc: '0.01', vat: '0', expected: '9998999999999.99', steps: '× 0.9999 = 9998999999999.990001 -> 9998999999999.99' },
];

describe('ADR-059 golden: line total = one rounding, HALF_UP, discount before VAT (TZ §6.6)', () => {
  it.each(CASES)('$name: $steps', ({ qty, price, disc, vat, expected }) => {
    expect(round2(calcLineTotal(qty, price, disc, vat))).toBe(expected);
  });

  it('is symmetric in sign: a credit (negative qty) rounds away from zero exactly like a debit', () => {
    // -1000.5 × 0.01 = -10.005 -> -10.01 (HALF_UP = away from zero)
    expect(round2(calcLineTotal('-1000.500', '0.01', 0, 0))).toBe('-10.01');
    // -0.001 × 4.99 = -0.00499 -> -0.00 (Decimal toFixed renders -0.00 as "-0.00"; value is zero)
    expect(calcLineTotal('-0.001', '4.99', 0, 0).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).isZero()).toBe(true);
  });
});

describe('ADR-059 golden: partial delivery recomputes from deliveredQty and rounds once (F2.4)', () => {
  function amounts(qty: string, deliveredQty: string, price: string, disc: string, vat: string, lineTotal: string) {
    return { qty: D(qty), deliveredQty: D(deliveredQty), unitPrice: D(price), discountPct: D(disc), vatRate: D(vat), lineTotal: D(lineTotal) };
  }
  const PARTIAL: { name: string; line: ReturnType<typeof amounts>; expected: string; steps: string }[] = [
    { name: '12 of 30', line: amounts('30', '12', '12500.00', '12.5', '12', '367500.00'), expected: '147000.00', steps: '12 × 12500 = 150000; × 0.875 = 131250; × 1.12 = 147000' },
    { name: '4.001 of 7.125', line: amounts('7.125', '4.001', '333.33', '0', '12', '2659.97'), expected: '1493.69', steps: '4.001 × 333.33 = 1333.65333; × 1.12 = 1493.6917296 -> 1493.69' },
    { name: '0.333 of 0.5 (x.xx6 7)', line: amounts('0.5', '0.333', '99999.99', '0', '0', '50000.00'), expected: '33300.00', steps: '0.333 × 99999.99 = 33299.99667 -> 33300.00' },
    { name: '0.1 of 0.333 with 12.5% + VAT 12', line: amounts('0.333', '0.1', '333.33', '12.5', '12', '108.78'), expected: '32.67', steps: '0.1 × 333.33 = 33.333; × 0.875 = 29.166375; × 1.12 = 32.66634 -> 32.67' },
    { name: '7.5 of 10 with VAT 15 (8625.43125)', line: amounts('10', '7.5', '1000.05', '0', '15', '11500.58'), expected: '8625.43', steps: '7.5 × 1000.05 = 7500.375; × 1.15 = 8625.43125 -> 8625.43' },
    { name: '0.5 of 1.5', line: amounts('1.5', '0.5', '4.46', '0', '12', '7.49'), expected: '2.50', steps: '0.5 × 4.46 = 2.23; × 1.12 = 2.4976 -> 2.50' },
    { name: 'fully delivered keeps snapshot lineTotal (50000.00, not recomputed 49999.995)', line: amounts('0.5', '0.5', '99999.99', '0', '0', '50000.00'), expected: '50000.00', steps: 'snapshot as stored' },
    { name: 'nothing delivered -> 0.00', line: amounts('1', '0', '4.46', '0', '12', '5.00'), expected: '0.00', steps: '0 × anything' },
  ];

  it.each(PARTIAL)('$name: $steps', ({ line, expected }) => {
    expect(deliveredLineTotal(line).toFixed(2)).toBe(expected);
  });
});
