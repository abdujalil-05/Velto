import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantClient } from '@velto/database';

export interface TenantStore {
  companyId: string;
  /** Throws (fail-closed) for a handler-scope store, which has no open transaction. */
  readonly tx: TenantClient;
  afterCommit: Array<() => unknown>;
  /** True only while a tenant transaction is open on this async chain. */
  readonly txActive?: boolean;
}

const NO_TX_MESSAGE =
  "No open tenant transaction: this route is @TenantTx({ scope: 'handler' }); " +
  'open one with TenantPrismaService.run(companyId, fn) (fail-closed, no bare Prisma).';

/** Store for @TenantTx({ scope: 'handler' }) routes: companyId known, no tx, any tx access throws. */
export function handlerScopeStore(companyId: string): TenantStore {
  return {
    companyId,
    txActive: false,
    get tx(): TenantClient {
      throw new Error(NO_TX_MESSAGE);
    },
    get afterCommit(): Array<() => unknown> {
      throw new Error(NO_TX_MESSAGE);
    },
  };
}

const als = new AsyncLocalStorage<TenantStore>();

/**
 * Request-scoped tenant context. Populated once per request by the auth
 * guard/interceptor (once it has resolved the authenticated user's
 * companyId from the JWT — see the upcoming auth module) via
 * `TenantPrismaService.run()`, and read from anywhere deeper in that same
 * request's call stack without threading `tx`/`companyId` through every
 * function signature.
 */
export const TenantContext = {
  run<T>(store: TenantStore, fn: () => T): T {
    return als.run(store, fn);
  },

  /** The active store if any (no throw). */
  peek(): TenantStore | undefined {
    return als.getStore();
  },

  get current(): TenantStore {
    const store = als.getStore();
    if (!store) {
      throw new Error(
        'No tenant context is active. This code path must run inside TenantPrismaService.run(companyId, fn) — ' +
          'set by the auth guard once a request is authenticated, never called with a client-supplied companyId.',
      );
    }
    return store;
  },

  get companyId(): string {
    return TenantContext.current.companyId;
  },

  get client(): TenantClient {
    return TenantContext.current.tx;
  },

  /**
   * Registers a callback to run only once the current request's transaction
   * has actually committed — for side effects (e.g. enqueueing a BullMQ job)
   * that must never fire before the DB rows they reference are durably
   * visible to other connections. Calling `queue.add()` directly inside the
   * transaction risks a worker dequeuing and querying for a row before this
   * same transaction's COMMIT lands, since the whole request runs inside one
   * `TenantPrismaService.run()` call (TenantContextInterceptor) that only
   * commits after the response is ready.
   */
  afterCommit(cb: () => unknown): void {
    TenantContext.current.afterCommit.push(cb);
  },
};
