import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionDeniedException } from '../../../common/auth/auth-exceptions';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { prisma, systemPrisma } from '@velto/database';
import { CashSessionAlreadyOpenException, NoOpenCashSessionException } from '../finance-exceptions';
import { CashSessionsService } from './cash-sessions.service';

describe('CashSessionsService (integration, real Postgres + RLS)', () => {
  let companyId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const cashSessions = new CashSessionsService(tenantPrisma, auditLog);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-cash-${Date.now()}`, name: 'Cash Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Cash Test Co' } });
    companyId = company.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function createUser(roles: string[] = ['CASHIER']): Promise<AuthenticatedUser> {
    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Cash', lastName: 'Ier', phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
    });
    return { id: dbUser.id, companyId, firstName: 'Cash', lastName: 'Ier', roles, permissions: ['cash.open', 'cash.close'] };
  }

  it('open() then close() round-trips a shift', async () => {
    const user = await createUser();
    const opened = await tenantPrisma.run(companyId, () => cashSessions.open({ openAmount: 50000 }, user));
    expect(opened.closedAt).toBeNull();

    const closed = await tenantPrisma.run(companyId, () => cashSessions.close(opened.id, { closeAmount: 60000 }, user));
    expect(closed.closedAt).not.toBeNull();
  });

  it('rejects opening a second session while one is already open', async () => {
    const user = await createUser();
    await tenantPrisma.run(companyId, () => cashSessions.open({ openAmount: 10000 }, user));

    await expect(tenantPrisma.run(companyId, () => cashSessions.open({ openAmount: 10000 }, user))).rejects.toBeInstanceOf(
      CashSessionAlreadyOpenException,
    );
  });

  it('under concurrent opens for the same user, only one succeeds (partial unique index, no double-open)', async () => {
    const user = await createUser();
    const attempt = () => tenantPrisma.run(companyId, () => cashSessions.open({ openAmount: 10000 }, user));

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CashSessionAlreadyOpenException);

    const openSessions = await tenantPrisma.run(companyId, (tx) =>
      tx.cashSession.findMany({ where: { userId: user.id, closedAt: null } }),
    );
    expect(openSessions).toHaveLength(1);
  });

  it("refuses to let another cashier close someone else's session, but allows an OWNER to", async () => {
    const cashier = await createUser();
    const otherCashier = await createUser();
    const owner = await createUser(['OWNER']);

    const session = await tenantPrisma.run(companyId, () => cashSessions.open({ openAmount: 10000 }, cashier));

    await expect(
      tenantPrisma.run(companyId, () => cashSessions.close(session.id, { closeAmount: 10000 }, otherCashier)),
    ).rejects.toBeInstanceOf(PermissionDeniedException);

    const closed = await tenantPrisma.run(companyId, () => cashSessions.close(session.id, { closeAmount: 10000 }, owner));
    expect(closed.closedAt).not.toBeNull();
  });

  it('current() and close() throw when there is no open session', async () => {
    const user = await createUser();
    await expect(tenantPrisma.run(companyId, () => cashSessions.current(user))).rejects.toBeInstanceOf(NoOpenCashSessionException);
    await expect(
      tenantPrisma.run(companyId, () => cashSessions.close('00000000-0000-0000-0000-000000000000', { closeAmount: 0 }, user)),
    ).rejects.toBeInstanceOf(NoOpenCashSessionException);
  });
});
