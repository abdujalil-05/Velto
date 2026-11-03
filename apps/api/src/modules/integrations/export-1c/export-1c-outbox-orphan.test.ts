import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import { FakeBullQueue } from '../../../common/queue/fake-bull-queue';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import type { Export1cJobData } from './export-1c.constants';
import { Export1cRecoveryService } from './export-1c-recovery.service';

/** ADR-064: QUEUED export whose BullMQ entry is failed/completed must be recovered or, past 24h, failed. */
describe('1C export outbox orphans (real Postgres, BullMQ jobId-dedup double)', () => {
  const tenantPrisma = new TenantPrismaService();
  let companyId: string;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-exp-orphan-${randomUUID().slice(0, 8)}`, name: 'Export Orphan Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Export Orphan Co' } })).id;
  });
  afterEach(() => {
    delete process.env.ABANDONED_QUEUED_MS;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function make(ageMs: number, month: number) {
    return tenantPrisma.run(companyId, async (tx) => {
      const j = await tx.exportJob.create({ data: { companyId, type: '1c', format: 'CSV', periodFrom: new Date(Date.UTC(2026, month, 1)), periodTo: new Date(Date.UTC(2026, month, 28)) } });
      await tx.exportJob.update({ where: { id: j.id }, data: { updatedAt: new Date(Date.now() - ageMs) } });
      return j.id;
    });
  }
  const status = async (id: string) => (await systemPrisma.exportJob.findUniqueOrThrow({ where: { id } })).status;

  it('QUEUED row with a failed BullMQ entry is removed and re-added (waiting)', async () => {
    const q = new FakeBullQueue();
    const id = await make(20 * 60_000, 0);
    q.jobs.set(`export-${id}`, { name: 'export', data: {}, state: 'failed' });
    await new Export1cRecoveryService(tenantPrisma, q.asQueue<Export1cJobData>()).sweep();
    expect(q.jobs.get(`export-${id}`)?.state).toBe('waiting');
    expect(await status(id)).toBe('QUEUED');
  });

  it('>24h QUEUED with a failed BullMQ entry is FAILED even though enqueue "succeeds" (409 limit released)', async () => {
    const q = new FakeBullQueue();
    const id = await make(25 * 3_600_000, 1);
    q.jobs.set(`export-${id}`, { name: 'export', data: {}, state: 'failed' });
    await new Export1cRecoveryService(tenantPrisma, q.asQueue<Export1cJobData>()).sweep();
    expect(await status(id)).toBe('FAILED');
    const audit = await systemPrisma.auditLog.findMany({ where: { companyId, entity: 'ExportJob', entityId: id, action: 'export.failed_abandoned' } });
    expect(audit).toHaveLength(1);
  });

  it('one re-enqueue failure does not stop the remaining orphans', async () => {
    const q = new FakeBullQueue();
    const a = await make(20 * 60_000, 2);
    const b = await make(20 * 60_000, 3);
    const add = q.add;
    const flaky = Object.assign(Object.create(q), {
      getJob: q.getJob,
      add: async (n: string, d: unknown, o: { jobId: string }) => {
        if (o.jobId === `export-${a}`) throw new Error('boom');
        return add(n, d, o);
      },
    });
    await new Export1cRecoveryService(tenantPrisma, flaky as never).sweep();
    expect(q.jobs.has(`export-${b}`)).toBe(true);
  });
});
