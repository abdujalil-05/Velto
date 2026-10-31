import { Injectable, Logger } from '@nestjs/common';
import { withTenant, type TenantClient, type TenantTxOptions } from '@velto/database';
import { perfMetrics } from '../perf/perf-metrics';
import { getTraceId } from '../trace/trace-context';
import { TenantContext } from './tenant-context';

@Injectable()
export class TenantPrismaService {
  private readonly logger = new Logger(TenantPrismaService.name);

  /**
   * Runs `fn` inside a tenant-scoped RLS transaction and exposes it via
   * TenantContext for the duration. Callbacks registered via
   * `TenantContext.afterCommit()` during `fn` run only once this promise's
   * `withTenant()` call has resolved — i.e. strictly after COMMIT — so they
   * can safely assume every write `fn` made is durably visible to any other
   * connection (e.g. a BullMQ worker on a separate connection).
   * `options` (isolation level / timeout) are passed through to withTenant().
   */
  async run<T>(
    companyId: string,
    fn: (tx: TenantClient) => Promise<T>,
    options?: TenantTxOptions,
    internal?: { allowNested?: boolean },
  ): Promise<T> {
    if (TenantContext.peek()?.txActive && !internal?.allowNested) {
      // Holding an outer tx while waiting for a 2nd pool connection can
      // self-deadlock the pool (N outer txs all waiting => P2024).
      const msg = 'nested tenantPrisma.run: a tenant transaction is already open on this call chain';
      if (process.env.NODE_ENV !== 'production') throw new Error(msg);
      this.logger.error(`${msg} (traceId=${getTraceId() ?? 'n/a'})`);
    }
    const afterCommit: Array<() => unknown> = [];
    const afterRollback: Array<() => unknown> = [];
    const requestedAt = perfMetrics.enabled ? performance.now() : 0;
    let result: T;
    try {
      result = await withTenant(
        companyId,
        (tx) => {
          // Approximation of pool wait: request -> entering the callback also includes BEGIN + SET LOCAL.
          if (requestedAt) perfMetrics.recordPoolWait(performance.now() - requestedAt);
          return TenantContext.run({ companyId, tx, afterCommit, afterRollback, txActive: true }, () => fn(tx));
        },
        options,
      );
    } catch (err) {
      // Contract: afterRollback fires only when the OUTER request tx rolls back; errors caught inside the tx (savepoints) are not audited by it.
      // ADR-061: the tx (and its connection/locks) is released here; callbacks may open their own tx. Never mask `err`.
      for (const cb of afterRollback) {
        try {
          await TenantContext.detached(() => cb());
        } catch (e) {
          this.logger.error(`afterRollback callback failed: ${e instanceof Error ? e.message : 'error'}`);
        }
      }
      throw err;
    }
    // One failing callback must not starve the others; the first error is rethrown once all have run.
    let firstError: unknown;
    let failed = false;
    for (const cb of afterCommit) {
      try {
        await cb();
      } catch (e) {
        this.logger.error(`afterCommit callback failed: ${e instanceof Error ? e.name : 'error'}`);
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    }
    if (failed) throw firstError;
    return result;
  }

  /** The current request's tenant-scoped client. Throws outside of `run()` — see TenantContext. */
  get client(): TenantClient {
    return TenantContext.client;
  }

  get companyId(): string {
    return TenantContext.companyId;
  }
}
