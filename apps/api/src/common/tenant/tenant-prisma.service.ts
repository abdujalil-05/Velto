import { Injectable } from '@nestjs/common';
import { withTenant, type TenantClient } from '@velto/database';
import { TenantContext } from './tenant-context';

@Injectable()
export class TenantPrismaService {
  /**
   * Runs `fn` inside a tenant-scoped RLS transaction and exposes it via
   * TenantContext for the duration. Callbacks registered via
   * `TenantContext.afterCommit()` during `fn` run only once this promise's
   * `withTenant()` call has resolved — i.e. strictly after COMMIT — so they
   * can safely assume every write `fn` made is durably visible to any other
   * connection (e.g. a BullMQ worker on a separate connection).
   */
  async run<T>(companyId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    const afterCommit: Array<() => unknown> = [];
    const result = await withTenant(companyId, (tx) => TenantContext.run({ companyId, tx, afterCommit }, () => fn(tx)));
    for (const cb of afterCommit) {
      await cb();
    }
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
