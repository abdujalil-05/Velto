import { describe, expect, it } from 'vitest';
import { formatMoney, formatQty } from './format';

const NB = ' ';

describe('formatMoney', () => {
  it.each<[number | string, string]>([
    [0, '0,00'],
    [1234567, `1${NB}234${NB}567,00`],
    [1000.01, `1${NB}000,01`],
    ['999999999999.99', `999${NB}999${NB}999${NB}999,99`],
    [0.5, '0,50'],
  ])('%s -> 2dp, NBSP groups, comma decimal', (input, expected) => {
    expect(formatMoney(input)).toBe(expected);
  });
  it('never mixes separators', () => {
    const out = formatMoney(1234567.891);
    expect(out).toBe(`1${NB}234${NB}567,89`);
    expect(out).not.toMatch(/[ .]/);
  });
  it('non-finite -> 0,00', () => expect(formatMoney(NaN)).toBe('0,00'));
});

describe('formatQty', () => {
  it.each<[number | string, string]>([
    [3, '3'],
    [0.125, '0,125'],
    [1.5, '1,5'],
    [1234.5678, `1${NB}234,568`], // max 3 decimals, rounded
    [1000, `1${NB}000`],
  ])('%s', (input, expected) => {
    expect(formatQty(input)).toBe(expected);
  });
});
