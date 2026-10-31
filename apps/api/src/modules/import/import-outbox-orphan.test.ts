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
import { ScopedImportRecoveryService as ImportRecoveryService } from './scoped-import-recovery';
import { retryImportJob } from '../../scripts/retry-import-job';
import { importRecoveryMaxAttempts, type ImportJobData } from './import.constants';
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

    const n = await new ImportRecoveryService(tenantPrisma, q.asQueue<ImportJobData>()).sweep(new Date(Date.now() + 86_400_000), companyId);
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
    await new ImportRecoveryService(tenantPrisma, flaky as never).sweep(new Date(Date.now() + 86_400_000), companyId);
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

  describe('ADR-064b bounded recovery', () => {
    const FUTURE = () => new Date(Date.now() + 24 * 3600_000);
    async function processing(codes: string[]) {
      const q = new FakeBullQueue();
      const svc = new ImportService(tenantPrisma, storage, q.asQueue(), new AuditLogService());
      const created = await upload(svc, codes);
      await tenantPrisma.run(companyId, (tx) => tx.importJob.update({ where: { id: created.id }, data: { status: 'PROCESSING' } }));
      return { q, id: created.id };
    }
    const sweepOf = (q: FakeBullQueue, now?: Date) => new ImportRecoveryService(tenantPrisma, q.asQueue<ImportJobData>()).sweep(now, companyId);

    it('backoff: fresh updatedAt is not recovered, no attempt burned', async () => {
      const { q, id } = await processing(['BO-1']);
      await sweepOf(q);
      expect((await row(id)).attemptCount).toBe(0);
      expect(q.jobs.has(`import-${id}`)).toBe(false);
    });

    it('missing -> attemptCount+1 and enqueue; active/waiting/delayed untouched', async () => {
      const { q, id } = await processing(['MS-1']);
      await sweepOf(q, FUTURE());
      expect((await row(id)).attemptCount).toBe(1);
      expect(q.jobs.get(`import-${id}`)?.state).toBe('waiting');
      for (const st of ['active', 'waiting', 'delayed']) {
        q.setState(`import-${id}`, st);
        await sweepOf(q, new Date(Date.now() + 10 * 24 * 3600_000));
        expect((await row(id)).attemptCount).toBe(1);
        expect(q.jobs.get(`import-${id}`)?.state).toBe(st);
      }
    });

    it('parallel sweeps: only one claims the attempt', async () => {
      const { q, id } = await processing(['PAR-1']);
      const now = new Date(Date.now() + 301_000);
      await Promise.all([sweepOf(q, now), sweepOf(q, now), sweepOf(q, now)]);
      expect((await row(id)).attemptCount).toBe(1);
    });

    it('exhausted -> FAILED + audit, imported rows kept; terminal never re-executed', async () => {
      const { q, id } = await processing(['EX-1', 'EX-2']);
      const max = importRecoveryMaxAttempts();
      await tenantPrisma.run(companyId, (tx) => tx.importJob.update({ where: { id }, data: { attemptCount: max } }));
      const created = await tenantPrisma.run(companyId, async (tx) => {
        await tx.customer.create({ data: { companyId, code: 'EX-KEEP', name: 'Keep' } });
        return true;
      });
      expect(created).toBe(true);
      await sweepOf(q, FUTURE());
      const r = await row(id);
      expect(r.status).toBe('FAILED');
      expect((r.errorLog as { code?: string }).code).toBe('IMPORT_RECOVERY_EXHAUSTED');
      expect(q.jobs.has(`import-${id}`)).toBe(false);
      expect(await tenantPrisma.run(companyId, (tx) => tx.auditLog.count({ where: { action: 'import.failed_recovery_exhausted', entityId: id } }))).toBe(1);
      expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count({ where: { code: 'EX-KEEP' } }))).toBe(1);
      expect(((r.errorLog as { rows?: unknown[] }).rows ?? []).length).toBe(2); // resumable payload kept

      // operator retry: refuses other states, dry-run is read-only, real run resumes to DONE without resetting attemptCount
      const args = { companyId, jobId: id, reason: 'test', operator: 'test-operator', dryRun: true };
      await retryImportJob(args);
      expect((await row(id)).status).toBe('FAILED');
      await retryImportJob({ ...args, dryRun: false }, q.asQueue<ImportJobData>());
      const after = await row(id);
      expect(after.status).toBe('PROCESSING');
      expect(after.attemptCount).toBe(max);
      expect(q.jobs.get(`import-${id}`)?.state).toBe('waiting');
      expect(await tenantPrisma.run(companyId, (tx) => tx.auditLog.count({ where: { action: 'import.recovery_manual_retry', entityId: id } }))).toBe(1);
      await runWorker(q, id);
      expect((await row(id)).status).toBe('DONE');
      await expect(retryImportJob({ ...args, dryRun: false }, q.asQueue<ImportJobData>())).rejects.toThrow(/Refusing/);
    });

    it('Redis down (getJob throws): no DB change, no attempt burned', async () => {
      const { q, id } = await processing(['RD-1']);
      const down = Object.assign(Object.create(q), { getJob: async () => { throw new Error('ECONNREFUSED'); } });
      await new ImportRecoveryService(tenantPrisma, down as never).sweep(FUTURE(), companyId);
      const r = await row(id);
      expect(r.attemptCount).toBe(0);
      expect(r.status).toBe('PROCESSING');
    });

    it('enqueue failure after claim releases the attempt', async () => {
      const { q, id } = await processing(['EF-1']);
      const bad = Object.assign(Object.create(q), { add: async () => { throw new Error('enqueue timeout'); } });
      await new ImportRecoveryService(tenantPrisma, bad as never).sweep(FUTURE(), companyId);
      expect((await row(id)).attemptCount).toBe(0);
    });
  });
});
