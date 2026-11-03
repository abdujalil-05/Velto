/**
 * NFR timing assertions (TZ 12.1/12.5) are separated from correctness.
 * `pnpm test` checks behaviour only; `pnpm test:perf` (PERF=1) additionally
 * enforces the time budgets. Thresholds are NOT relaxed — only gated.
 */
export const PERF = process.env.PERF === '1';

/** Fails when PERF=1 and `ms` >= `limitMs`; otherwise a no-op (value is still logged by callers). */
export function expectWithinBudget(label: string, ms: number, limitMs: number): void {
  if (!PERF) return;
  if (!(ms < limitMs)) throw new Error(`[PERF] ${label}: ${ms} ms exceeds budget ${limitMs} ms`);
}
