import { SetMetadata } from '@nestjs/common';
import type { TenantTxOptions } from '@velto/database';

export const TENANT_TX_OPTIONS_KEY = 'tenantTxOptions';

/**
 * Per-route options for the request's tenant transaction opened by
 * TenantContextInterceptor. Default is Prisma's 5 s timeout; only routes that
 * must write a large, all-or-nothing batch in ONE transaction (opening balance
 * post/void, ≤5000 rows) raise it.
 */
export const TenantTx = (options: TenantTxOptions) => SetMetadata(TENANT_TX_OPTIONS_KEY, options);
