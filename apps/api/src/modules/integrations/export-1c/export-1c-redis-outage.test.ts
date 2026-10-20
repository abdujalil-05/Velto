import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { enqueueTimeoutMs, withEnqueueTimeout } from '../../../common/queue/trace-job';
import { export1cAbandonedQueuedMs, type Export1cJobData } from './export-1c.constants';
import { Export1cLimitsService } from './export-1c-limits.service';
import { Export1cRecoveryService } from './export-1c-recovery.service';
import { Export1cService } from './export-1c.service';

/** ADR-047 / NFR-REL-006: Redis down must not hang or fail the request; the QUEUED row waits for the sweep. */
describe('1C export under a Redis outage (real Postgres, queue test double)', () => {
  const tenantPrisma = new TenantPrismaService();
  let companyId: string;
  let user: AuthenticatedUser;
  const hangingQueue = { add: vi.fn(() => new Promise(() => undefined)) } as unknown as Queue<Export1cJobData>;
  const noLimit = { assertCanCreate: async () => undefined } as unknown as Export1cLimitsService;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-outage-${randomUUID().slice(0, 8)}`, name: 'Outage Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Outage Co' } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'A', lastName: 'B', phone: `+99890${Math.floor(1e6 + Math.random() * 9e6)}` } });
    user = { id: u.id, companyId, firstName: 'A', lastName: 'B', roles: ['ACCOUNTANT'], permissions: ['integrations.export1c'] };
  });
  afterEach(() => {
    delete process.env.QUEUE_ENQUEUE_TIMEOUT_MS;
    delete process.env.ABANDONED_QUEUED_MS;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('create returns 2xx within timeout+margin and the ExportJob stays QUEUED', async () => {
    process.env.QUEUE_ENQUEUE_TIMEOUT_MS = '300';
    const svc = new Export1cService(tenantPrisma, hangingQueue, new AuditLogService(), noLimit);
    const t0 = Date.now();
    const job = await tenantPrisma.run(companyId, () => svc.create({ from: '2026-07-01', to: '2026-07-31' }, user));
    expect(Date.now() - t0).toBeLessThan(1500);
    const row = await systemPrisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('QUEUED');
  });

  it('sweep after Redis returns enqueues a stale QUEUED job once; double enqueue dedupes by jobId', async () => {
    const svc = new Export1cService(tenantPrisma, hangingQueue, new AuditLogService(), noLimit);
    process.env.QUEUE_ENQUEUE_TIMEOUT_MS = '200';
    const job = await tenantPrisma.run(companyId, () => svc.create({ from: '2026-06-01', to: '2026-06-30' }, user));
    await systemPrisma.exportJob.update({ where: { id: job.id }, data: { updatedAt: new Date(Date.now() - 3600_000) } });

    const seen = new Map<string, number>(); // BullMQ semantics: same jobId is a no-op
    const redisBack = { add: vi.fn(async (_n: string, _d: unknown, o: { jobId: string }) => void seen.set(o.jobId, (seen.get(o.jobId) ?? 0) + 1)) } as unknown as Queue<Export1cJobData>;
    const recovery = new Export1cRecoveryService(tenantPrisma, redisBack);
    await recovery.sweep();
    await recovery.sweep();
    const adds = (redisBack.add as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[2] as { jobId: string }).jobId === `export-${job.id}`);
    expect(adds.length).toBe(2); // sweep re-offers; the queue collapses duplicates
    const row = await systemPrisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('QUEUED'); // not failed: younger than ABANDONED (24h)
  });

  it('ABANDONED defaults to 24h; a short env value fails old QUEUED rows when Redis is still down', async () => {
    expect(export1cAbandonedQueuedMs()).toBe(24 * 3600_000);
    process.env.ABANDONED_QUEUED_MS = '60000';
    process.env.QUEUE_ENQUEUE_TIMEOUT_MS = '100';
    const svc = new Export1cService(tenantPrisma, hangingQueue, new AuditLogService(), noLimit);
    const job = await tenantPrisma.run(companyId, () => svc.create({ from: '2026-05-01', to: '2026-05-31' }, user));
    await systemPrisma.exportJob.update({ where: { id: job.id }, data: { updatedAt: new Date(Date.now() - 3600_000) } });
    await new Export1cRecoveryService(tenantPrisma, hangingQueue).sweep();
    const row = await systemPrisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('FAILED');
  });

  it('a failing afterCommit callback does not stop the others; first error is rethrown', async () => {
    const ran: string[] = [];
    await expect(
      tenantPrisma.run(companyId, async () => {
        TenantContext.afterCommit(() => { throw new Error('boom'); });
        TenantContext.afterCommit(() => void ran.push('second'));
      }),
    ).rejects.toThrow('boom');
    expect(ran).toEqual(['second']);
  });

  it('timeout helper rejects a hung promise; default timeout is 3000ms', async () => {
    expect(enqueueTimeoutMs()).toBe(3000);
    await expect(withEnqueueTimeout(new Promise(() => undefined), 50)).rejects.toThrow('enqueue timeout');
  });
});
