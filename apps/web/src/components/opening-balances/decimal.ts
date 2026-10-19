/** Canonical form of a non-negative decimal string ("0010.50" -> "10.5") for exact string comparison — never float math. */
export function canonicalDecimal(value: string): string {
  const [int = '', frac = ''] = value.trim().replace(',', '.').split('.');
  const i = int.replace(/^0+(?=\d)/, '') || '0';
  const f = frac.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

export function sameDecimal(a: string, b: string): boolean {
  return canonicalDecimal(a) === canonicalDecimal(b);
}

export const MONEY_PATTERN = /^\d{1,15}([.,]\d{1,2})?$/;
export const QTY_PATTERN = /^\d{1,9}([.,]\d{1,3})?$/;
