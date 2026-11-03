/** Offline Unlock passphrase policy (ADR-071). Pure; returns machine codes (UI translates them). */
export type PassphraseIssue = 'tooShort' | 'tooLong' | 'allDigits' | 'repeatedRun' | 'sequentialRun' | 'containsName' | 'containsPhone' | 'denylisted' | 'mismatch';

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 128;

const DENYLIST = ['password', 'parol', 'пароль', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn', 'velto', 'admin', 'welcome', 'letmein', 'iloveyou', 'uzbekistan', 'ozbekiston', 'o\'zbekiston', 'toshkent', 'tashkent', 'йцукен'];

export interface PassphraseContext {
  firstName?: string;
  lastName?: string;
  phone?: string;
}

function hasRun(chars: string[], predicate: (a: number, b: number, c: number) => boolean): boolean {
  for (let i = 0; i + 2 < chars.length; i++) {
    if (predicate(chars[i]!.codePointAt(0)!, chars[i + 1]!.codePointAt(0)!, chars[i + 2]!.codePointAt(0)!)) return true;
  }
  return false;
}

export function validatePassphrase(pass: string, ctx: PassphraseContext = {}, confirm?: string): PassphraseIssue[] {
  const issues: PassphraseIssue[] = [];
  const chars = Array.from(pass);
  if (chars.length < MIN_PASSPHRASE_LENGTH) issues.push('tooShort');
  if (chars.length > MAX_PASSPHRASE_LENGTH) issues.push('tooLong');
  if (chars.length > 0 && /^\d+$/.test(pass)) issues.push('allDigits');
  const lower = Array.from(pass.toLowerCase());
  if (hasRun(lower, (a, b, c) => a === b && b === c)) issues.push('repeatedRun');
  if (hasRun(lower, (a, b, c) => (b - a === 1 && c - b === 1) || (a - b === 1 && b - c === 1))) issues.push('sequentialRun');
  const l = pass.toLowerCase();
  for (const n of [ctx.firstName, ctx.lastName]) {
    const v = n?.trim().toLowerCase();
    if (v && v.length >= 3 && l.includes(v)) {
      issues.push('containsName');
      break;
    }
  }
  const digits = pass.replace(/\D/g, '');
  const phone = (ctx.phone ?? '').replace(/\D/g, '');
  if (phone.length >= 7 && (digits.includes(phone) || digits.includes(phone.slice(-9)))) issues.push('containsPhone');
  if (DENYLIST.some((w) => l.includes(w))) issues.push('denylisted');
  if (confirm !== undefined && confirm !== pass) issues.push('mismatch');
  return issues;
}
