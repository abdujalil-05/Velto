import { SetMetadata } from '@nestjs/common';
import type { TenantTxOptions } from '@velto/database';

export const TENANT_TX_OPTIONS_KEY = 'tenantTxOptions';

/**
 * Per-route options for the request's tenant transaction opened by
 * TenantContextInterceptor. Default is Prisma's 5 s timeout; only routes that
 * must write a large, all-or-nothing batch in ONE transaction (opening balance
 * post/void, ≤5000 rows) raise it.
 */
export type TenantTxScope = 'request' | 'handler';
export type TenantTxRouteOptions = TenantTxOptions & {
  /**
   * 'request' (default): one tx spans the whole handler. 'handler': the
   * interceptor authenticates/authorizes in a short tx, COMMITs, then runs the
   * handler with NO open tx; the handler opens its own short
   * `tenantPrisma.run()` txs (nested `run` is forbidden).
   */
  scope?: TenantTxScope;
};

export const TenantTx = (options: TenantTxRouteOptions) => SetMetadata(TENANT_TX_OPTIONS_KEY, options);
