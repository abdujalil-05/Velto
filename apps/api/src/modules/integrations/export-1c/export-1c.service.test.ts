import { AuditLogService } from '../../../common/audit/audit-log.service';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { runWithTraceId } from '../../../common/trace/trace-context';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { ExportJobNotFoundException, ExportPeriodNotClosedException, InvalidExportPeriodException } from '../integrations-exceptions';
import type { Export1cJobData } from './export-1c.constants';
import { Export1cService } from './export-1c.service';
import { ExportActiveLimitException, ExportFormatRequiredException } from './export-1c-exceptions';
import { Export1cLimitsService } from './export-1c-limits.service';

describe('Export1cService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const queueAdd = vi.fn().mockResolvedValue(undefined);
  const fakeQueue = { add: queueAdd } as unknown as Queue<Export1cJobData>;
  const export1c = new Export1cService(tenantPrisma, fakeQueue, new AuditLogService(), { assertCanCreate: async () => undefined } as unknown as Export1cLimitsService); // limit covered by its own test below
  const limited = new Export1cService(tenantPrisma, fakeQueue, new AuditLogService(), new Export1cLimitsService(tenantPrisma));

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

  it('rejects a missing format (no implicit EXCEL default)', async () => {
    await expect(
      tenantPrisma.run(companyId, () => export1c.create({ from: '2026-07-01', to: '2026-07-31' }, user)),
    ).rejects.toBeInstanceOf(ExportFormatRequiredException);
  });

  it('creates a QUEUED job and enqueues it for the worker', async () => {
    const job = await runWithTraceId('known-trace-id-123', () =>
      tenantPrisma.run(companyId, () => export1c.create({ from: '2026-07-01', to: '2026-07-31', format: 'EXCEL' }, user)),
    );
    expect(job.status).toBe('QUEUED');
    expect(job.format).toBe('EXCEL'); // XML not pilot-validated
    expect(queueAdd).toHaveBeenCalledWith('export', { exportJobId: job.id, companyId, traceId: 'known-trace-id-123' }, expect.objectContaining({ attempts: 3, jobId: `export-${job.id}` }));
  });

  it('day boundaries follow Company.timezone (Asia/Tashkent), not the server clock; CSV accepted', async () => {
    const job = await tenantPrisma.run(companyId, () => export1c.create({ from: '2026-07-01', to: '2026-07-31', format: 'CSV' }, user));
    expect(job.format).toBe('CSV');
    expect(job.periodFrom.toISOString()).toBe('2026-06-30T19:00:00.000Z'); // 2026-07-01 00:00 +05
    expect(job.periodTo.toISOString()).toBe('2026-07-31T18:59:59.999Z'); // 2026-07-31 23:59:59.999 +05
  });

  it('accepts an explicit XML format', async () => {
    const job = await tenantPrisma.run(companyId, () =>
      export1c.create({ from: '2026-07-01', to: '2026-07-31', format: 'XML' }, user),
    );
    expect(job.format).toBe('XML');
  });

  describe('period must end yesterday or earlier (company timezone Asia/Tashkent, UTC+5)', () => {
    let n = 0; // unique period per call (active-period unique index)
    const at = async (iso: string, to: string) => {
      const from = `2025-01-${String(++n).padStart(2, '0')}`;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
      try {
        return await tenantPrisma.run(companyId, () => export1c.create({ from, to, format: 'EXCEL' }, user));
      } finally {
        vi.useRealTimers();
      }
    };

    it('rejects today', async () => {
      await expect(at('2026-09-10T08:00:00Z', '2026-09-10')).rejects.toBeInstanceOf(ExportPeriodNotClosedException);
    });
    it('accepts yesterday', async () => {
      await expect(at('2026-09-10T08:00:00Z', '2026-09-09')).resolves.toBeDefined();
    });
    it('rejects the future', async () => {
      await expect(at('2026-09-10T08:00:00Z', '2026-09-20')).rejects.toBeInstanceOf(ExportPeriodNotClosedException);
    });
    it('Tashkent day boundary: 20:00Z Sep 9 is already Sep 10 locally, so Sep 9 is yesterday (ok) and Sep 10 is today (rejected)', async () => {
      await expect(at('2026-09-09T20:00:00Z', '2026-09-09')).resolves.toBeDefined();
      await expect(at('2026-09-09T20:00:00Z', '2026-09-10')).rejects.toBeInstanceOf(ExportPeriodNotClosedException);
    });
    it('Tashkent day boundary: 04:59Z is still the same local day, 05:00Z starts the next', async () => {
      await expect(at('2026-09-10T04:59:00Z', '2026-09-09')).resolves.toBeDefined();
      await expect(at('2026-09-10T04:59:00Z', '2026-09-10')).rejects.toBeInstanceOf(ExportPeriodNotClosedException);
      await expect(at('2026-09-10T05:00:00Z', '2026-09-10')).rejects.toBeInstanceOf(ExportPeriodNotClosedException);
    });
  });

  it('rejects a period where "from" is after "to"', async () => {
    await expect(
      tenantPrisma.run(companyId, () => export1c.create({ from: '2026-08-01', to: '2026-07-01', format: 'EXCEL' }, user)),
    ).rejects.toBeInstanceOf(InvalidExportPeriodException);
  });

  it('list() and getById() round-trip a created job', async () => {
    const created = await tenantPrisma.run(companyId, () => export1c.create({ from: '2026-06-01', to: '2026-06-30', format: 'EXCEL' }, user));
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

  it('parallel creates (distinct periods) never exceed the active limit: <= 3 jobs, the rest 429', async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-export1c-lim-${Date.now()}`, name: 'Export1c Limit Tenant' } });
    const co = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Export1c Limit Co' } })).id;
    const u = await systemPrisma.user.create({ data: { companyId: co, firstName: 'L', lastName: 'Im', phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}` } });
    const limUser: AuthenticatedUser = { ...user, id: u.id, companyId: co };
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6].map((d) => tenantPrisma.run(co, () => limited.create({ from: `2026-05-0${d}`, to: `2026-05-0${d}`, format: 'EXCEL' }, limUser))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.reason instanceof ExportActiveLimitException)).toBe(true);
    expect(await tenantPrisma.run(co, (tx) => tx.exportJob.count())).toBe(3);
  });
});
