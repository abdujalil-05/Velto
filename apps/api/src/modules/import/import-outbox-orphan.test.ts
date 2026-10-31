import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { FakeBullQueue } from '../../common/queue/fake-bull-queue';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { StorageService } from '../../common/storage/storage.service';
import { ImportQueueUnavailableException } from './import-exceptions';
import { ImportRecoveryService } from './import-recovery.service';
import type { ImportJobData } from './import.constants';
import { ImportProcessor } from './import.processor';
import { ImportService } from './import.service';
import { buildTestWorkbook } from './parsers/test-workbook';

/** ADR-064: terminal BullMQ entry + non-terminal row must not strand an import (dedup-by-jobId). */
describe('Import outbox orphans (real Postgres + RLS, BullMQ jobId-dedup double)', () => {
  const tenantPrisma = new TenantPrismaService();
  const processor = new ImportProcessor(tenantPrisma, new AuditLogService());
  let companyId: string;
  let user: AuthenticatedUser;
  const storage = { upload: vi.fn().mockResolvedValue('https://storage.test/imports/f.xlsx') } as unknown as StorageService;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-imp-orphan-${randomUUID().slice(0, 8)}`, name: 'Import Orphan Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Import Orphan Co' } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'O', lastName: 'W', phone: `+99891${Math.floor(1e6 + Math.random() * 9e6)}` } });
    user = { id: u.id, companyId, firstName: 'O', lastName: 'W', roles: ['OWNER'], permissions: ['settings.update'] };
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const row = (id: string) => systemPrisma.importJob.findUniqueOrThrow({ where: { id } });
  async function upload(svc: ImportService, codes: string[]) {
    const buf = await buildTestWorkbook(['code', 'name'], codes.map((c) => [c, `N ${c}`]));
    return tenantPrisma.run(companyId, () => svc.uploadAndValidate('customers', buf, user));
  }
  /** Worker double: runs the queued job through the real processor and marks the BullMQ entry completed. */
  async function runWorker(q: FakeBullQueue, importJobId: string) {
    await processor.process({ data: { importJobId, companyId } } as unknown as Job<ImportJobData>);
    q.setState(`import-${importJobId}`, 'completed');
  }

  it('late enqueue lands after timeout revert, worker no-ops (completed); re-confirm still reaches DONE', async () => {
    const q = new FakeBullQueue();
    const lateAdd = q.add;
    let first = true;
    const flaky = Object.assign(Object.create(q), {
      add: async (n: string, d: unknown, o: { jobId: string }) => {
        if (first) {
          first = false;
          await lateAdd(n, d, o); // lands in Redis...
          throw new Error('enqueue timeout'); // ...but the caller saw a timeout
        }
        return lateAdd(n, d, o);
      },
    });
    const svc = new ImportService(tenantPrisma, storage, flaky as never, new AuditLogService());
    const created = await upload(svc, ['LATE-1', 'LATE-2']);

    await expect(tenantPrisma.run(companyId, () => svc.confirm(created.id, user))).rejects.toBeInstanceOf(ImportQueueUnavailableException);
    expect((await row(created.id)).status).toBe('PENDING');
    await runWorker(q, created.id); // row is PENDING -> no-op, entry completed

    await tenantPrisma.run(companyId, () => svc.confirm(created.id, user));
    await runWorker(q, created.id);
    expect((await row(created.id)).status).toBe('DONE');
    expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count({ where: { code: { startsWith: 'LATE-' } } }))).toBe(2);
  });

  it('sweep re-enqueues a PROCESSING import whose BullMQ entry is completed', async () => {
    const q = new FakeBullQueue();
    const svc = new ImportService(tenantPrisma, storage, q.asQueue(), new AuditLogService());
    const created = await upload(svc, ['SWP-1']);
    await tenantPrisma.run(companyId, (tx) => tx.importJob.update({ where: { id: created.id }, data: { status: 'PROCESSING' } }));
    q.jobs.set(`import-${created.id}`, { name: 'commit', data: {}, state: 'completed' });

    const n = await new ImportRecoveryService(tenantPrisma, q.asQueue<ImportJobData>()).sweep();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(q.jobs.get(`import-${created.id}`)?.state).toBe('waiting');
    await runWorker(q, created.id);
    expect((await row(created.id)).status).toBe('DONE');
  });

  it('sweep continues after one job throws', async () => {
    const q = new FakeBullQueue();
    const svc = new ImportService(tenantPrisma, storage, q.asQueue(), new AuditLogService());
    const a = await upload(svc, ['CNT-1']);
    const b = await upload(svc, ['CNT-2']);
    await tenantPrisma.run(companyId, (tx) => tx.importJob.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { status: 'PROCESSING' } }));
    const real = q.getJob;
    const flaky = Object.assign(Object.create(q), {
      getJob: async (id: string) => {
        if (id === `import-${a.id}`) throw new Error('redis blip');
        return real(id);
      },
    });
    await new ImportRecoveryService(tenantPrisma, flaky as never).sweep();
    expect(q.jobs.get(`import-${b.id}`)?.state).toBe('waiting');
  });

  it('zombie + redelivered run of the same job reach DONE without duplicate rows', async () => {
    const svc = new ImportService(tenantPrisma, storage, new FakeBullQueue().asQueue(), new AuditLogService());
    const created = await upload(svc, ['ZMB-1', 'ZMB-2', 'ZMB-3']);
    await tenantPrisma.run(companyId, (tx) => tx.importJob.update({ where: { id: created.id }, data: { status: 'PROCESSING' } }));
    const job = { data: { importJobId: created.id, companyId } } as unknown as Job<ImportJobData>;
    await Promise.all([processor.process(job), processor.process(job)]);
    expect((await row(created.id)).status).toBe('DONE');
    expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count({ where: { code: { startsWith: 'ZMB-' } } }))).toBe(3);
  });
});
