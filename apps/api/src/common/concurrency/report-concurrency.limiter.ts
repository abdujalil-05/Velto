import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_REPORT_MAX_CONCURRENCY,
  DEFAULT_REPORT_QUEUE_MAX,
  DEFAULT_REPORT_QUEUE_TIMEOUT_MS,
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
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export function reportLimiterOptionsFromEnv(): ReportLimiterOptions {
  return {
    maxConcurrency: envInt('REPORT_MAX_CONCURRENCY', DEFAULT_REPORT_MAX_CONCURRENCY, 1),
    queueMax: envInt('REPORT_QUEUE_MAX', DEFAULT_REPORT_QUEUE_MAX, 0),
    queueTimeoutMs: envInt('REPORT_QUEUE_TIMEOUT_MS', DEFAULT_REPORT_QUEUE_TIMEOUT_MS, 1),
  };
}

type Waiter = { grant: () => void; reject: (e: unknown) => void };

/**
 * Process-level counting semaphore with a bounded FIFO wait queue for heavy
 * report computations. Acquired in a guard, i.e. BEFORE the tenant transaction
 * opens, so a waiting request holds no DB connection. A release function is
 * idempotent; a waiter that is aborted (client gone) or times out leaves the
 * queue without ever taking a permit.
 */
@Injectable()
export class ReportConcurrencyLimiter {
  private readonly opts: ReportLimiterOptions;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(@Optional() @Inject(REPORT_LIMITER_OPTIONS) opts?: Partial<ReportLimiterOptions>) {
    this.opts = { ...reportLimiterOptionsFromEnv(), ...opts };
  }

  get stats() {
    return { active: this.active, queued: this.queue.length };
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new ReportBusyException();
    if (this.active < this.opts.maxConcurrency) {
      this.active++;
      return this.makeRelease();
    }
    if (this.queue.length >= this.opts.queueMax) throw new ReportBusyException();

    return new Promise<() => void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        // The permit is transferred directly from the releaser (active stays counted).
        grant: () => {
          cleanup();
          resolve(this.makeRelease());
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      };
      const leave = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        waiter.reject(new ReportBusyException());
      };
      const onAbort = leave;
      const timer = setTimeout(leave, this.opts.queueTimeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.grant();
      else this.active--;
    };
  }
}
