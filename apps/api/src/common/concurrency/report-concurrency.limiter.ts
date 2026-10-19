import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_REPORT_MAX_CONCURRENCY,
  DEFAULT_REPORT_QUEUE_MAX,
  DEFAULT_REPORT_QUEUE_TIMEOUT_MS,
  DEFAULT_REPORT_TENANT_MAX_CONCURRENCY,
  DEFAULT_REPORT_TENANT_QUEUE_MAX,
} from '../config/env.schema';
import { AppException } from '../errors/app-exception';

export const REPORT_RETRY_AFTER_SECONDS = 2;
export const REPORT_LIMITER_OPTIONS = Symbol('REPORT_LIMITER_OPTIONS');

export class ReportBusyException extends AppException {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_BUSY', {
      uz: "Server band — birozdan so'ng qayta urinib ko'ring",
      ru: 'Сервер занят — повторите попытку чуть позже',
      en: 'Server is busy — please retry shortly',
    });
  }
}

export interface ReportLimiterOptions {
  maxConcurrency: number;
  queueMax: number;
  queueTimeoutMs: number;
  /** Max simultaneously active permits per tenant key (<= maxConcurrency). */
  tenantMaxConcurrency: number;
  /** Max queued waiters per tenant key. */
  tenantQueueMax: number;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export function reportLimiterOptionsFromEnv(): ReportLimiterOptions {
  const maxConcurrency = envInt('REPORT_MAX_CONCURRENCY', DEFAULT_REPORT_MAX_CONCURRENCY, 1);
  return {
    maxConcurrency,
    tenantMaxConcurrency: envInt('REPORT_TENANT_MAX_CONCURRENCY', DEFAULT_REPORT_TENANT_MAX_CONCURRENCY, 1),
    tenantQueueMax: envInt('REPORT_TENANT_QUEUE_MAX', DEFAULT_REPORT_TENANT_QUEUE_MAX, 0),
    queueMax: envInt('REPORT_QUEUE_MAX', DEFAULT_REPORT_QUEUE_MAX, 0),
    queueTimeoutMs: envInt('REPORT_QUEUE_TIMEOUT_MS', DEFAULT_REPORT_QUEUE_TIMEOUT_MS, 1),
  };
}

type Waiter = { key?: string; grant: () => void; reject: (e: unknown) => void };

/**
 * Process-level counting semaphore with a bounded wait queue for heavy report
 * computations, plus a per-tenant quota (noisy-neighbour guard): a tenant key
 * holds at most `tenantMaxConcurrency` permits and `tenantQueueMax` queue
 * slots, so one tenant can neither occupy every permit nor fill the queue.
 * Fairness = FIFO scan skipping waiters whose tenant is at its cap, so a free
 * permit always goes to the oldest waiter that is allowed to run. Without a
 * key (internal callers) no per-tenant quota applies. Acquired in a guard,
 * i.e. BEFORE the tenant transaction opens, so a waiter holds no DB
 * connection. A release function is idempotent; a waiter that is aborted
 * (client gone) or times out leaves the queue without ever taking a permit.
 */
@Injectable()
export class ReportConcurrencyLimiter {
  private readonly opts: ReportLimiterOptions;
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly tenantActive = new Map<string, number>();
  private readonly tenantQueued = new Map<string, number>();

  constructor(@Optional() @Inject(REPORT_LIMITER_OPTIONS) opts?: Partial<ReportLimiterOptions>) {
    const merged = { ...reportLimiterOptionsFromEnv(), ...opts };
    merged.tenantMaxConcurrency = Math.min(merged.tenantMaxConcurrency, merged.maxConcurrency);
    this.opts = merged;
  }

  get stats() {
    return { active: this.active, queued: this.queue.length };
  }

  private bump(map: Map<string, number>, key: string | undefined, d: number) {
    if (key === undefined) return;
    const n = (map.get(key) ?? 0) + d;
    if (n <= 0) map.delete(key);
    else map.set(key, n);
  }

  private tenantFree(key: string | undefined): boolean {
    return key === undefined || (this.tenantActive.get(key) ?? 0) < this.opts.tenantMaxConcurrency;
  }

  async acquire(signal?: AbortSignal, tenantKey?: string): Promise<() => void> {
    if (signal?.aborted) throw new ReportBusyException();
    if (this.active < this.opts.maxConcurrency && this.tenantFree(tenantKey)) {
      return this.take(tenantKey);
    }
    if (this.queue.length >= this.opts.queueMax) throw new ReportBusyException();
    if (tenantKey !== undefined && (this.tenantQueued.get(tenantKey) ?? 0) >= this.opts.tenantQueueMax) {
      throw new ReportBusyException();
    }

    return new Promise<() => void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        key: tenantKey,
        grant: () => {
          cleanup();
          resolve(this.take(tenantKey));
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      };
      const leave = () => {
        if (this.dequeue(waiter)) waiter.reject(new ReportBusyException());
      };
      const onAbort = leave;
      const timer = setTimeout(leave, this.opts.queueTimeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      this.bump(this.tenantQueued, tenantKey, 1);
    });
  }

  private dequeue(waiter: Waiter): boolean {
    const i = this.queue.indexOf(waiter);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    this.bump(this.tenantQueued, waiter.key, -1);
    return true;
  }

  private take(key: string | undefined): () => void {
    this.active++;
    this.bump(this.tenantActive, key, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.bump(this.tenantActive, key, -1);
      this.dispatch();
    };
  }

  /** Grants free permits to the oldest eligible waiters (tenant under its cap). */
  private dispatch() {
    while (this.active < this.opts.maxConcurrency) {
      const next = this.queue.find((w) => this.tenantFree(w.key));
      if (!next) return;
      this.dequeue(next);
      next.grant();
    }
  }
}
