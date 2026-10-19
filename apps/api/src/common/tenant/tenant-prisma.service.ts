import { Injectable, Logger } from '@nestjs/common';
import { withTenant, type TenantClient, type TenantTxOptions } from '@velto/database';
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
  ): Promise<T> {
    const afterCommit: Array<() => unknown> = [];
    const result = await withTenant(
      companyId,
      (tx) => TenantContext.run({ companyId, tx, afterCommit }, () => fn(tx)),
      options,
    );
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
