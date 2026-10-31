/** Exact decimal helpers for display/validation previews only — BigInt, no float math. Backend stays authoritative. */

interface Scaled {
  n: bigint;
  scale: number;
}

function parse(value: string): Scaled | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim().replace(',', '.'));
  if (!m) return null;
  const frac = m[2] ?? '';
  return { n: BigInt(m[1]! + frac), scale: frac.length };
}

function rescale(v: Scaled, scale: number): bigint {
  return v.n * 10n ** BigInt(scale - v.scale);
}

/** True when Σ parts > limit (decimal strings); unparseable parts count as 0. */
export function sumExceeds(parts: string[], limit: string): boolean {
  const all = [...parts.map(parse), parse(limit)].filter((p): p is Scaled => p !== null);
  const scale = Math.max(0, ...all.map((p) => p.scale));
  const sum = parts.reduce((s, p) => {
    const v = parse(p);
    return v ? s + rescale(v, scale) : s;
  }, 0n);
  const lim = parse(limit);
  return sum > (lim ? rescale(lim, scale) : 0n);
}

/**
 * Mirrors server line total: qty × price × (1 − d/100) × (1 + v/100), exact, then HALF_UP to 2dp.
 * Returns a "123.45" string, or null if any input is not a plain non-negative decimal.
 */
export function lineTotalHalfUp(qty: string, price: string, discountPct: string, vatPct: string): string | null {
  const q = parse(qty);
  const p = parse(price);
  const d = parse(discountPct || '0');
  const v = parse(vatPct || '0');
  if (!q || !p || !d || !v) return null;
  const hundred = 100n;
  // (100 − d) and (100 + v) at their own scales
  const dFactor = hundred * 10n ** BigInt(d.scale) - d.n;
  const vFactor = hundred * 10n ** BigInt(v.scale) + v.n;
  const num = q.n * p.n * dFactor * vFactor;
  const scale = q.scale + p.scale + d.scale + v.scale;
  // value = num / 10^scale / 10^4 ; want cents = value × 100
  const den = 10n ** BigInt(scale + 2);
  const cents = (num * 2n + den) / (den * 2n);
  const c = cents < 0n ? 0n : cents;
  return `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
}

function format(n: bigint, scale: number): string {
  if (scale === 0) return n.toString();
  const s = n.toString().padStart(scale + 1, '0');
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** Exact product of two decimal strings, or null if unparseable. */
export function mulDecimal(a: string, b: string): string | null {
  const x = parse(a);
  const y = parse(b);
  return x && y ? format(x.n * y.n, x.scale + y.scale) : null;
}

/** Exact sum of decimal strings (unparseable parts count as 0). */
export function sumDecimal(parts: string[]): string {
  const vals = parts.map(parse).filter((p): p is Scaled => p !== null);
  const scale = Math.max(0, ...vals.map((p) => p.scale));
  return format(vals.reduce((s, p) => s + rescale(p, scale), 0n), scale);
}
