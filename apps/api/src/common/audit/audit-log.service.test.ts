import { describe, expect, it, vi } from 'vitest';
import type { TenantClient } from '@velto/database';
import { runWithTraceId } from '../trace/trace-context';
import { AuditLogService } from './audit-log.service';

const entry = { companyId: 'c1', action: 'x.create', entity: 'X', entityId: 'x1' };

function stub() {
  const create = vi.fn().mockResolvedValue({});
  return { create, tx: { auditLog: { create } } as unknown as TenantClient };
}

describe('AuditLogService redaction', () => {
  it('keeps fileHash visible while token/password/other hash keys stay masked', async () => {
    const { create, tx } = stub();
    await new AuditLogService().log(tx, {
      ...entry,
      newValue: { fileHash: 'abc123', ackChecksum: 'abc123', downloadToken: 't', password: 'p', passwordHash: 'h' },
    });
    expect(create.mock.calls[0][0].data.newValue).toEqual({
      fileHash: 'abc123',
      ackChecksum: 'abc123',
      downloadToken: '***',
      password: '***',
      passwordHash: '***',
    });
  });

  it('masks secret keys recursively, keeps others', async () => {
    const { create, tx } = stub();
    await new AuditLogService().log(tx, {
      ...entry,
      oldValue: { name: 'a', passwordHash: 'h', nested: { RefreshToken: 't', otp: '1', qty: 3 } },
      newValue: {
        list: [{ botToken: 'b', initData: 'i', secret: 's', hash: 'x', ok: 'y' }],
        password: 'p',
      },
    });
    const d = create.mock.calls[0][0].data;
    expect(d.oldValue).toEqual({ name: 'a', passwordHash: '***', nested: { RefreshToken: '***', otp: '***', qty: 3 } });
    expect(d.newValue).toEqual({
      list: [{ botToken: '***', initData: '***', secret: '***', hash: '***', ok: 'y' }],
      password: '***',
    });
  });

  it('masks substring/extended keys, allowlists initDataHashPrefix', async () => {
    const { create, tx } = stub();
    await new AuditLogService().log(tx, {
      ...entry,
      newValue: {
        newPassword: 'a',
        currentPassword: 'b',
        otpCode: '1',
        authorization: 'Bearer x',
        apiKey: 'k',
        cookie: 'c',
        pin: '1234',
        code: '99',
        initDataHashPrefix: 'abcd',
        codeName: 'keep',
      },
    });
    expect(create.mock.calls[0][0].data.newValue).toEqual({
      newPassword: '***',
      currentPassword: '***',
      otpCode: '***',
      authorization: '***',
      apiKey: '***',
      cookie: '***',
      pin: '***',
      code: '99',
      initDataHashPrefix: 'abcd',
      codeName: 'keep',
    });
  });

  it('leaves undefined as undefined', async () => {
    const { create, tx } = stub();
    await new AuditLogService().log(tx, entry);
    expect(create.mock.calls[0][0].data.oldValue).toBeUndefined();
  });
});

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
