/**
 * Spreadsheet formula-injection defence (SEC-001/009), shared by every CSV/XLSX writer
 * (reports, import error report, 1C export).
 *
 * Cells starting (after optional leading whitespace) with `=`, `@`, tab or CR, or `+`/`-`
 * followed by something that is not a digit/phone/number character, are neutralised with a
 * leading `'`. Numbers and phones (`+998901234567`, `-5`, `(99) 123-45-67`) and UUIDs stay intact.
 */
export function isFormulaLike(raw: string): boolean {
  if (/^[\t\r]/.test(raw)) return true;
  const t = raw.trimStart();
  if (/^[=@\t\r]/.test(t)) return true;
  if (/^[+-]/.test(t)) return !/^[+-][\s]*[\d(.,]/.test(t) || !/^[+-][\d\s().,-]*$/.test(t);
  return false;
}

/** Neutralises a text cell; non-strings (numbers, null, dates) pass through untouched. */
export function sanitizeCell<T>(value: T): T | string {
  return typeof value === 'string' && isFormulaLike(value) ? `'${value}` : value;
}
