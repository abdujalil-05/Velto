import { randomInt } from 'node:crypto';
import argon2 from 'argon2';

export const RECOVERY_CODE_COUNT = 10;
// No 0/o/1/i/l: codes are read off paper.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const HALF = 5;

/** Strips separators/case so `ABCDE-FGHJK`, `abcde fghjk` and `abcdefghjk` are the same code. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase();
}

function randomHalf(): string {
  return Array.from({ length: HALF }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** Fresh crypto-random set. `plain` is shown to the user once; only `hashes` (argon2id of the normalized code) are stored. */
export async function generateRecoveryCodes(): Promise<{ plain: string[]; hashes: string[] }> {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () => `${randomHalf()}-${randomHalf()}`);
  const hashes = await Promise.all(plain.map((code) => argon2.hash(normalizeRecoveryCode(code), { type: argon2.argon2id })));
  return { plain, hashes };
}

/** Sequential on purpose (bounded CPU/memory per request). Returns the matching row or undefined. */
export async function findMatchingRecoveryCode<T extends { codeHash: string }>(rows: T[], input: string): Promise<T | undefined> {
  const normalized = normalizeRecoveryCode(input);
  let match: T | undefined;
  for (const row of rows) {
    if (await argon2.verify(row.codeHash, normalized)) match ??= row;
  }
  return match;
}
