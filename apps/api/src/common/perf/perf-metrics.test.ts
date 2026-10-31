import { describe, expect, it } from 'vitest';
import { PerfMetrics, percentile } from './perf-metrics';

describe('PerfMetrics', () => {
  it('aggregates pool waits and resets per flush', () => {
    const lines: string[] = [];
    const m = new PerfMetrics(true, (l) => lines.push(l));
    for (let i = 1; i <= 100; i++) m.recordPoolWait(i);
    m.flush();
    expect(lines[0]).toBe('perf {"m":"poolwait","count":100,"p50":50,"p95":95,"max":100}');
    m.flush();
    expect(lines[1]).toContain('"count":0');
    expect(percentile([], 50)).toBe(0);
  });

  it('logs dashboard compute as one perf line', () => {
    const lines: string[] = [];
    new PerfMetrics(true, (l) => lines.push(l)).logDashboardCompute({ mode: 'cold', permitWaitMs: 1, poolWaitMs: 2, computeMs: 3 });
    expect(lines).toEqual(['perf {"m":"dashboard.compute","mode":"cold","permitWaitMs":1,"poolWaitMs":2,"computeMs":3}']);
  });

  it('is a no-op when disabled', () => {
    const lines: string[] = [];
    const m = new PerfMetrics(false, (l) => lines.push(l));
    m.start();
    m.recordPoolWait(5);
    m.logDashboardCompute({ mode: 'refresh', permitWaitMs: 0, poolWaitMs: 0, computeMs: 0 });
    m.flush();
    expect(lines).toEqual([]);
    expect((m as unknown as { timer?: unknown }).timer).toBeUndefined();
  });
});
