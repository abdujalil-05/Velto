import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../src/common/audit/audit-log.service';
import type { AuthenticatedUser } from '../src/common/auth/auth.types';
import type { StorageService } from '../src/common/storage/storage.service';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { CompanyExportProcessor } from '../src/modules/company-export/company-export.processor';
import { CompanyExportService } from '../src/modules/company-export/company-export.service';
import type { CompanyExportJobData } from '../src/modules/company-export/company-export.constants';
import { Export1cRecoveryService } from '../src/modules/integrations/export-1c/export-1c-recovery.service';
import { Export1cService } from '../src/modules/integrations/export-1c/export-1c.service';
import type { Export1cLimitsService } from '../src/modules/integrations/export-1c/export-1c-limits.service';
import type { Export1cJobData } from '../src/modules/integrations/export-1c/export-1c.constants';
import { ImportRecoveryService } from '../src/modules/import/import-recovery.service';
import { ImportProcessor } from '../src/modules/import/import.processor';
import { ImportService } from '../src/modules/import/import.service';
import type { ImportJobData } from '../src/modules/import/import.constants';

/** ADR-064 outbox: rollback => no row/no enqueue (T1), import sweep branches (T2), per-tenant sweep (T3), foreign-companyId worker payloads (T4). Real Postgres + RLS. */
describe('ADR-064 outbox (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const audit = new AuditLogService();
  const rid = () => randomUUID().slice(0, 8);
  const hourAgo = () => new Date(Date.now() - 3600_000);
  const noLimit = { assertCanCreate: async () => undefined } as unknown as Export1cLimitsService;

  interface Tn {
    companyId: string;
    user: AuthenticatedUser;
  }
  async function seedTenant(label: string): Promise<Tn> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-outbox-${label}-${rid()}`, name: `Outbox ${label}` } });
    const companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Outbox ${label} Co` } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: label, lastName: 'Outbox', phone: `+99890${Math.floor(1e6 + Math.random() * 9e6)}` } });
    return { companyId, user: { id: u.id, companyId, firstName: label, lastName: 'Outbox', roles: ['OWNER'], permissions: [] } };
  }
  const newQueue = <T>() => ({ add: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(undefined) }) as unknown as Queue<T> & { add: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn> };
  const addedIds = (q: { add: ReturnType<typeof vi.fn> }) => q.add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
  const boom = new Error('business failure after job creation');

  async function pendingImport(t: Tn, status: 'PENDING' | 'PROCESSING' = 'PENDING', rows: unknown[] = []) {
    return tenantPrisma.run(t.companyId, (tx) =>
      tx.importJob.create({
        data: { companyId: t.companyId, type: 'customers', status, fileUrl: 'https://storage.test/f.xlsx', createdBy: t.user.id, errorLog: { totalRows: rows.length, validCount: rows.length, invalidCount: 0, errors: [], rows } as never },
      }),
    );
  }
  async function exportRow(t: Tn, type: '1c' | 'company', status: 'QUEUED' | 'PROCESSING', updatedAt: Date) {
    const row = await tenantPrisma.run(t.companyId, async (tx) => {
      const j = await tx.exportJob.create({ data: { companyId: t.companyId, type, format: 'EXCEL', periodFrom: new Date(), periodTo: new Date(), status: 'QUEUED' } });
      if (status === 'PROCESSING') await tx.exportJob.update({ where: { id: j.id }, data: { status: 'PROCESSING', attemptCount: 1 } });
      return j;
    });
    await systemPrisma.exportJob.update({ where: { id: row.id }, data: { updatedAt } });
    return row;
  }
  const dbExport = (id: string) => systemPrisma.exportJob.findUniqueOrThrow({ where: { id } });
  const dbImport = (id: string) => systemPrisma.importJob.findUniqueOrThrow({ where: { id } });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  describe('T1: business tx rollback => no job row, no enqueue (afterCommit dropped)', () => {
    let t: Tn;
    beforeAll(async () => {
      t = await seedTenant('rb');
    });

    it('1C export: rollback after create() leaves no ExportJob/audit and no queue.add; commit control does enqueue', async () => {
      const q = newQueue<Export1cJobData>();
      const svc = new Export1cService(tenantPrisma, q, audit, noLimit);
      const dto = { from: '2026-07-01', to: '2026-07-31' };
      await expect(
        tenantPrisma.run(t.companyId, async () => {
          const job = await svc.create(dto, t.user);
          expect(job.status).toBe('QUEUED');
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await systemPrisma.exportJob.count({ where: { companyId: t.companyId, type: '1c' } })).toBe(0);
      expect(await systemPrisma.auditLog.count({ where: { companyId: t.companyId, action: 'export.create' } })).toBe(0);
      expect(q.add).not.toHaveBeenCalled();

      const ok = await tenantPrisma.run(t.companyId, () => svc.create(dto, t.user)); // same period is free again: nothing leaked
      expect(addedIds(q)).toEqual([`export-${ok.id}`]);
    });

    it('company export: rollback => no row, no enqueue, no active-limit slot consumed', async () => {
      const q = newQueue<CompanyExportJobData>();
      const svc = new CompanyExportService(tenantPrisma, q, audit);
      await expect(
        tenantPrisma.run(t.companyId, async () => {
          await svc.create(t.user);
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await systemPrisma.exportJob.count({ where: { companyId: t.companyId, type: 'company' } })).toBe(0);
      expect(await systemPrisma.auditLog.count({ where: { companyId: t.companyId, action: 'company.export' } })).toBe(0);
      expect(q.add).not.toHaveBeenCalled();

      const ok = await tenantPrisma.run(t.companyId, () => svc.create(t.user));
      expect(addedIds(q)).toEqual([`export-${ok.id}`]);
    });

    it('import confirm: rollback => job stays PENDING, no audit, no enqueue; commit control enqueues once', async () => {
      const q = newQueue<ImportJobData>();
      const svc = new ImportService(tenantPrisma, {} as unknown as StorageService, q, audit);
      const job = await pendingImport(t);
      await expect(
        tenantPrisma.run(t.companyId, async () => {
          const r = await svc.confirm(job.id, t.user);
          expect(r.status).toBe('PROCESSING');
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect((await dbImport(job.id)).status).toBe('PENDING');
      expect(await systemPrisma.auditLog.count({ where: { companyId: t.companyId, action: 'import.confirm', entityId: job.id } })).toBe(0);
      expect(q.add).not.toHaveBeenCalled();

      await tenantPrisma.run(t.companyId, () => svc.confirm(job.id, t.user)); // still confirmable after the rolled-back attempt
      expect(addedIds(q)).toEqual([`import-${job.id}`]);
    });
  });

  describe('T2: import sweep branches', () => {
    it("'failed' queue entry => job marked FAILED in its tenant (no re-enqueue); 'missing' => re-enqueued with owner companyId; live entry untouched", async () => {
      const t = await seedTenant('imp-sweep');
      const failedJob = await pendingImport(t, 'PROCESSING');
      const missingJob = await pendingImport(t, 'PROCESSING');
      const activeJob = await pendingImport(t, 'PROCESSING');
      const state: Record<string, string> = { [failedJob.id]: 'failed', [activeJob.id]: 'active' };
      const q = newQueue<ImportJobData>();
      q.getJob.mockImplementation(async (jobId: string) => {
        const id = jobId.replace('import-', '');
        if (id === missingJob.id) return undefined;
        return { getState: async () => state[id] ?? 'active' }; // foreign rows from other suites: leave alone
      });
      const touched = await new ImportRecoveryService(tenantPrisma, q).sweep();
      expect(touched).toBeGreaterThanOrEqual(2);

      const f = await dbImport(failedJob.id);
      expect(f.status).toBe('FAILED');
      expect(f.errorLog).toBeTruthy();
      expect(addedIds(q)).not.toContain(`import-${failedJob.id}`);
      expect((await dbImport(missingJob.id)).status).toBe('PROCESSING');
      const call = q.add.mock.calls.find((c) => (c[2] as { jobId: string }).jobId === `import-${missingJob.id}`)!;
      expect(call[1]).toMatchObject({ importJobId: missingJob.id, companyId: t.companyId, userId: t.user.id });
      expect((await dbImport(activeJob.id)).status).toBe('PROCESSING');
      expect(addedIds(q)).not.toContain(`import-${activeJob.id}`);
    });
  });

  describe('T3: sweeps with stuck jobs of two tenants', () => {
    it('export sweep (1C + company, PROCESSING + orphan QUEUED) recovers each job inside its own tenant', async () => {
      const [A, B] = [await seedTenant('swA'), await seedTenant('swB')];
      const rows = {
        aProc: await exportRow(A, '1c', 'PROCESSING', hourAgo()),
        bProc: await exportRow(B, 'company', 'PROCESSING', hourAgo()),
        aQ: await exportRow(A, 'company', 'QUEUED', hourAgo()),
        bQ: await exportRow(B, '1c', 'QUEUED', hourAgo()),
        bFresh: await exportRow(B, '1c', 'PROCESSING', new Date()),
      };
      const q1c = newQueue<Export1cJobData>();
      const qCo = newQueue<CompanyExportJobData>();
      await new Export1cRecoveryService(tenantPrisma, q1c, qCo).sweep();

      expect((await dbExport(rows.aProc.id)).status).toBe('FAILED');
      expect((await dbExport(rows.bProc.id)).status).toBe('FAILED');
      expect((await dbExport(rows.bFresh.id)).status).toBe('PROCESSING'); // not stale: untouched
      for (const r of [rows.aProc, rows.bProc, rows.aQ, rows.bQ, rows.bFresh]) expect((await dbExport(r.id)).companyId).toBe(r.companyId); // no row migrated between tenants
      // orphans re-offered on the queue of their own type, carrying their OWN companyId
      const payload = (q: { add: ReturnType<typeof vi.fn> }, id: string) => q.add.mock.calls.find((c) => (c[2] as { jobId: string }).jobId === `export-${id}`)?.[1];
      expect(payload(qCo, rows.aQ.id)).toMatchObject({ exportJobId: rows.aQ.id, companyId: A.companyId });
      expect(payload(q1c, rows.bQ.id)).toMatchObject({ exportJobId: rows.bQ.id, companyId: B.companyId });
      expect(payload(q1c, rows.aQ.id)).toBeUndefined();
      expect(payload(qCo, rows.bQ.id)).toBeUndefined();
      expect((await dbExport(rows.aQ.id)).status).toBe('QUEUED');
      expect((await dbExport(rows.bQ.id)).status).toBe('QUEUED');
    });

    it('import sweep: stuck jobs of A and B each get a payload with their own companyId/userId; failed one is failed only in its own tenant', async () => {
      const [A, B] = [await seedTenant('isA'), await seedTenant('isB')];
      const aMissing = await pendingImport(A, 'PROCESSING');
      const bMissing = await pendingImport(B, 'PROCESSING');
      const bFailed = await pendingImport(B, 'PROCESSING');
      const aOther = await pendingImport(A, 'PROCESSING');
      const q = newQueue<ImportJobData>();
      q.getJob.mockImplementation(async (jobId: string) => {
        const id = jobId.replace('import-', '');
        if (id === aMissing.id || id === bMissing.id) return undefined;
        return { getState: async () => (id === bFailed.id ? 'failed' : 'active') };
      });
      await new ImportRecoveryService(tenantPrisma, q).sweep();
      const data = (id: string) => q.add.mock.calls.find((c) => (c[2] as { jobId: string }).jobId === `import-${id}`)?.[1];
      expect(data(aMissing.id)).toMatchObject({ companyId: A.companyId, userId: A.user.id });
      expect(data(bMissing.id)).toMatchObject({ companyId: B.companyId, userId: B.user.id });
      expect((await dbImport(bFailed.id)).status).toBe('FAILED');
      expect((await dbImport(bFailed.id)).companyId).toBe(B.companyId);
      expect((await dbImport(aOther.id)).status).toBe('PROCESSING'); // A's live job untouched by B's failure
    });
  });

  describe('T4: worker given a payload with ANOTHER tenant companyId => no-op', () => {
    it('ImportProcessor: A-job id under B companyId (and B-job id under A) reads/writes nothing in either tenant', async () => {
      const [A, B] = [await seedTenant('w4A'), await seedTenant('w4B')];
      const row = (code: string) => ({ rowNumber: 2, code, name: `N-${code}`, paymentTermDays: 0, outletName: 'O' });
      const jobA = await pendingImport(A, 'PROCESSING', [row('CA-1')]);
      const jobB = await pendingImport(B, 'PROCESSING', [row('CB-1')]);
      const processor = new ImportProcessor(tenantPrisma, audit);
      const fake = (importJobId: string, companyId: string) => ({ data: { importJobId, companyId } }) as unknown as Job<ImportJobData>;

      await processor.process(fake(jobA.id, B.companyId));
      await processor.process(fake(jobB.id, A.companyId));

      for (const [j, own] of [[jobA, A], [jobB, B]] as const) {
        const after = await dbImport(j.id);
        expect(after.status).toBe('PROCESSING');
        expect((after.errorLog as { commit?: unknown }).commit).toBeUndefined(); // cursor never advanced
        expect(after.companyId).toBe(own.companyId);
      }
      expect(await systemPrisma.customer.count({ where: { companyId: { in: [A.companyId, B.companyId] } } })).toBe(0);
      expect(await systemPrisma.auditLog.count({ where: { companyId: { in: [A.companyId, B.companyId] }, action: { in: ['customer.import', 'product.import'] } } })).toBe(0);
    });

    it('CompanyExportProcessor: A-job id under B companyId => not claimed, nothing generated/stored; real owner still processes it', async () => {
      const [A, B] = [await seedTenant('w5A'), await seedTenant('w5B')];
      const jobA = await exportRow(A, 'company', 'QUEUED', new Date());
      const jobB = await exportRow(B, 'company', 'QUEUED', new Date());
      const put = vi.fn(async (i: { body: NodeJS.ReadableStream }) => {
        for await (const _ of i.body) void _;
        return 'k';
      });
      const storage = { putObjectStream: put, getObject: vi.fn() } as unknown as StorageService;
      const processor = new CompanyExportProcessor(tenantPrisma, storage);
      const fake = (exportJobId: string, companyId: string) => ({ data: { exportJobId, companyId }, attemptsMade: 0, opts: { attempts: 3 } }) as unknown as Job<CompanyExportJobData>;

      await processor.process(fake(jobA.id, B.companyId));
      await processor.process(fake(jobB.id, A.companyId));
      for (const j of [jobA, jobB]) {
        const after = await dbExport(j.id);
        expect(after.status).toBe('QUEUED');
        expect(after.attemptCount).toBe(0);
        expect(after.storageKey).toBeNull();
      }
      expect(put).not.toHaveBeenCalled();

      await processor.process(fake(jobA.id, A.companyId)); // control: the matching tenant does process
      expect((await dbExport(jobA.id)).status).toBe('GENERATED');
      expect(put).toHaveBeenCalledTimes(1);
      expect((await dbExport(jobB.id)).status).toBe('QUEUED');
    });
  });
});
