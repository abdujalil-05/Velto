function toMilli(s: string): bigint {
  const [i, f = ''] = s.split('.');
  return BigInt(i || '0') * 1000n + BigInt((f + '000').slice(0, 3));
}

/** Display/validation-only difference of two decimal-string quantities (3 dp), clamped at 0 — integer thousandths, no float math. */
export function remainingQty(qty: string, received: string): string {
  const diff = toMilli(qty) - toMilli(received);
  const v = diff < 0n ? 0n : diff;
  return `${v / 1000n}.${(v % 1000n).toString().padStart(3, '0')}`;
}

/** True when a user-typed qty (decimal string) exceeds the limit. */
export function qtyExceeds(value: string, limit: string): boolean {
  return toMilli(value) > toMilli(limit);
}
