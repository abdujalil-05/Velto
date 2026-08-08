import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { ExportJobNotFoundException, InvalidExportPeriodException } from '../integrations-exceptions';
import type { Export1cJobData } from './export-1c.constants';
import { Export1cService } from './export-1c.service';

describe('Export1cService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const queueAdd = vi.fn().mockResolvedValue(undefined);
  const fakeQueue = { add: queueAdd } as unknown as Queue<Export1cJobData>;
  const export1c = new Export1cService(tenantPrisma, fakeQueue);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-export1c-${Date.now()}`, name: 'Export1c Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Export1c Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Acc', lastName: 'Ountant', phone: '+998900000099' },
    });
    user = { id: dbUser.id, companyId, firstName: 'Acc', lastName: 'Ountant', roles: ['ACCOUNTANT'], permissions: ['integrations.export1c'] };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('creates a PENDING job and enqueues it for the worker', async () => {
    const job = await tenantPrisma.run(companyId, () => export1c.create({ from: '2026-07-01', to: '2026-07-31' }, user));
    expect(job.status).toBe('PENDING');
    expect(job.format).toBe('XML'); // default per 11.1
    expect(queueAdd).toHaveBeenCalledWith('export', { exportJobId: job.id, companyId });
  });

  it('accepts an explicit EXCEL format', async () => {
    const job = await tenantPrisma.run(companyId, () =>
      export1c.create({ from: '2026-07-01', to: '2026-07-31', format: 'EXCEL' }, user),
    );
    expect(job.format).toBe('EXCEL');
  });

  it('rejects a period where "from" is after "to"', async () => {
    await expect(
      tenantPrisma.run(companyId, () => export1c.create({ from: '2026-08-01', to: '2026-07-01' }, user)),
    ).rejects.toBeInstanceOf(InvalidExportPeriodException);
  });

  it('list() and getById() round-trip a created job', async () => {
    const created = await tenantPrisma.run(companyId, () => export1c.create({ from: '2026-06-01', to: '2026-06-30' }, user));
    const fetched = await tenantPrisma.run(companyId, () => export1c.getById(created.id));
    expect(fetched.id).toBe(created.id);

    const list = await tenantPrisma.run(companyId, () => export1c.list({ page: 1, pageSize: 25 }));
    expect(list.data.some((j) => j.id === created.id)).toBe(true);
  });

  it('getById() throws for an unknown id', async () => {
    await expect(tenantPrisma.run(companyId, () => export1c.getById(randomUUID()))).rejects.toBeInstanceOf(
      ExportJobNotFoundException,
    );
  });
});
