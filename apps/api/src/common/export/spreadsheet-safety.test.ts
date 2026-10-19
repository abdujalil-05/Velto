import { describe, expect, it } from 'vitest';
import { isFormulaLike, sanitizeCell } from './spreadsheet-safety';

describe('spreadsheet-safety', () => {
  it.each(['+998901234567', '-5', '(99) 123-45-67', '+998 90 123-45-67', '  -12.5', 'Ali', 'a=b', '3f2b8c1e-9d4a-4e6b-8f1a-0c2d3e4f5a6b'])('keeps %j intact', (v) => {
    expect(isFormulaLike(v)).toBe(false);
    expect(sanitizeCell(v)).toBe(v);
  });
  it.each(['=1+1', '@SUM(A1)', '+cmd|x', '-cmd', '\tx', '\rx', '  =1+1', ' @x', '+1+cmd', '-A1'])('neutralises %j', (v) => {
    expect(isFormulaLike(v)).toBe(true);
    expect(sanitizeCell(v)).toBe(`'${v}`);
  });
  it('passes numbers, null and dates through', () => {
    const d = new Date();
    expect(sanitizeCell(-5)).toBe(-5);
    expect(sanitizeCell(null)).toBeNull();
    expect(sanitizeCell(d)).toBe(d);
  });
});
