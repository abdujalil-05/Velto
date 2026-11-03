import { describe, expect, it } from 'vitest';
import type { TenantClient } from '@velto/database';
import type { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { assertCustomersNotDeleted } from './customer-ledger-guard';

describe('assertCustomersNotDeleted in a store without afterRollback', () => {
  it('surfaces CUSTOMER_DELETED (not a plain Error) when the store has no rollback list', async () => {
    const tx = { customer: { findMany: async () => [{ id: 'c1' }] } } as unknown as TenantClient;
    const store = { companyId: 'co', tx, afterCommit: [] };
    const err = await TenantContext.run(store, () =>
      assertCustomersNotDeleted(tx, ['c1'], {
        tenantPrisma: {} as TenantPrismaService,
        auditLog: {} as AuditLogService,
        entry: { companyId: 'co', userId: 'u', action: 'payment.reverse', entity: 'Payment', entityId: 'p' },
      }).then(
        () => undefined,
        (e: { response?: { code?: string } }) => e,
      ),
    );
    expect(err?.response?.code).toBe('CUSTOMER_DELETED');
  });
});
