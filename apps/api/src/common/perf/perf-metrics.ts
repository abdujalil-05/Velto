import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';

const INTERVAL_MS = 10_000;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Opt-in diagnostics (PERF_METRICS=true). When disabled every method is a
 * no-op and no timer/histogram is created. Emits single-line `perf {json}`
 * Nest log lines; never includes company/user/tenant data.
 */
export class PerfMetrics {
  private readonly logger = new Logger('Perf');
  private poolWaits: number[] = [];
  private timer?: NodeJS.Timeout;
  private histogram?: IntervalHistogram;

  constructor(readonly enabled: boolean, private readonly emit: (line: string) => void = (l) => this.logger.log(l)) {}

  start(intervalMs = INTERVAL_MS): void {
    if (!this.enabled || this.timer) return;
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.histogram?.disable();
    this.timer = undefined;
    this.histogram = undefined;
  }

  /** Approximation: time from requesting a tenant tx until its callback is entered (pool wait + BEGIN + SET LOCAL). */
  recordPoolWait(ms: number): void {
    if (this.enabled) this.poolWaits.push(ms);
  }

  logDashboardCompute(d: { mode: 'cold' | 'refresh'; permitWaitMs: number; poolWaitMs: number; computeMs: number }): void {
    if (this.enabled) this.line({ m: 'dashboard.compute', ...d });
  }

  /** Emits and resets the interval aggregates. */
  flush(): void {
    if (!this.enabled) return;
    const h = this.histogram;
    if (h) {
      this.line({
        m: 'eventloop',
        p50: r1(h.percentile(50) / 1e6),
        p99: r1(h.percentile(99) / 1e6),
        max: r1(h.max / 1e6),
      });
      h.reset();
    }
    const w = this.poolWaits.sort((a, b) => a - b);
    this.poolWaits = [];
    this.line({
      m: 'poolwait',
      count: w.length,
      p50: r1(percentile(w, 50)),
      p95: r1(percentile(w, 95)),
      max: r1(w.length ? w[w.length - 1] : 0),
    });
  }

  private line(o: Record<string, unknown>): void {
    this.emit(`perf ${JSON.stringify(o)}`);
  }
}

export const perfMetrics = new PerfMetrics(process.env.PERF_METRICS === 'true');
