import { describe, expect, it, vi } from 'vitest';
import type { TenantClient } from '@velto/database';
import { runWithTraceId } from '../trace/trace-context';
import { AuditLogService } from './audit-log.service';

const entry = { companyId: 'c1', action: 'x.create', entity: 'X', entityId: 'x1' };

function stub() {
  const create = vi.fn().mockResolvedValue({});
  return { create, tx: { auditLog: { create } } as unknown as TenantClient };
}

describe('AuditLogService traceId', () => {
  it('stores current trace id', async () => {
    const { create, tx } = stub();
    await runWithTraceId('trace-abc12345', () => new AuditLogService().log(tx, entry));
    expect(create.mock.calls[0][0].data.traceId).toBe('trace-abc12345');
  });

  it('stores null outside a request', async () => {
    const { create, tx } = stub();
    await new AuditLogService().log(tx, entry);
    expect(create.mock.calls[0][0].data.traceId).toBeNull();
  });
});
