import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { FakeBullQueue } from '../../common/queue/fake-bull-queue';
import { addTracedJob } from '../../common/queue/trace-job';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { StorageService } from '../../common/storage/storage.service';
import { retryImportJob } from '../../scripts/retry-import-job';
import { IMPORT_COMMIT_FAILED } from './import-exceptions';
import { ScopedImportRecoveryService as ImportRecoveryService } from './scoped-import-recovery';
import { IMPORT_JOB_OPTS, importRecoveryMaxAttempts, type ImportJobData } from './import.constants';
import { ImportProcessor } from './import.processor';
import { ImportService } from './import.service';
import { buildTestWorkbook } from './parsers/test-workbook';

/** ADR-064b regression suite: ImportJob <-> BullMQ divergence recovery (D1 defect), bounded + tenant-safe. Real Postgres/RLS, FakeBullQueue with jobId-dedup semantics. */
describe('ADR-064b import recovery regression (real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const processor = new ImportProcessor(tenantPrisma, new AuditLogService());
  const storage = { upload: vi.fn().mockResolvedValue('https://storage.test/imports/f.xlsx') } as unknown as StorageService;
  const FUTURE = () => new Date(Date.now() + 24 * 3600_000);
  const tag = randomUUID().slice(0, 6).toUpperCase();
  type Ctx = { companyId: string; user: AuthenticatedUser };
  let A: Ctx;
  let B: Ctx;
  let C: Ctx;

  async function makeCompany(label: string): Promise<Ctx> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-imp-reg-${label}-${randomUUID().slice(0, 8)}`, name: `Import Reg ${label}` } });
    const companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Import Reg Co ${label}` } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'R', lastName: label, phone: `+99890${Math.floor(1e6 + Math.random() * 9e6)}` } });
    return { companyId, user: { id: u.id, companyId, firstName: 'R', lastName: label, roles: ['OWNER'], permissions: ['settings.update'] } };
  }
  beforeEach(async () => {
    [A, B, C] = await Promise.all([makeCompany('A'), makeCompany('B'), makeCompany('C')]);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const row = (id: string) => systemPrisma.importJob.findUniqueOrThrow({ where: { id } });
  const recovery = (q: unknown) => new ImportRecoveryService(tenantPrisma, q as Queue<ImportJobData>);
  const svcFor = (q: FakeBullQueue) => new ImportService(tenantPrisma, storage, q.asQueue(), new AuditLogService());
  const codes = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);

  /** Real upload (PENDING) -> real confirm (PROCESSING + enqueued). */
  async function confirmed(ctx: Ctx, q: FakeBullQueue, list: string[], type: 'customers' | 'products' = 'customers') {
    const buf = type === 'customers' ? await buildTestWorkbook(['code', 'name'], list.map((c) => [c, `N ${c}`])) : await buildTestWorkbook(['sku', 'name', 'baseUnit'], list.map((c) => [c, `P ${c}`, 'dona']));
    const svc = svcFor(q);
    const created = await tenantPrisma.run(ctx.companyId, () => svc.uploadAndValidate(type, buf, ctx.user));
    await tenantPrisma.run(ctx.companyId, () => svc.confirm(created.id, ctx.user));
    return created.id;
  }
  /** The D1 divergence: queue entry is gone (Redis flush / lost) while the row is PROCESSING. */
  const loseJob = (q: FakeBullQueue, id: string) => q.jobs.delete(`import-${id}`);
  async function runWorker(q: FakeBullQueue, ctx: Ctx, id: string) {
    await processor.process({ data: { importJobId: id, companyId: ctx.companyId }, opts: { attempts: 3 }, attemptsMade: 0 } as unknown as Job<ImportJobData>);
    q.setState(`import-${id}`, 'completed');
  }
  const countCustomers = (ctx: Ctx, prefix: string) => tenantPrisma.run(ctx.companyId, (tx) => tx.customer.count({ where: { code: { startsWith: prefix } } }));
  const countProducts = (ctx: Ctx, prefix: string) => tenantPrisma.run(ctx.companyId, (tx) => tx.product.count({ where: { sku: { startsWith: prefix } } }));

  it('1. isolated import: created in own tenant (PROCESSING, enqueued once), invisible to other tenants', async () => {
    const q = new FakeBullQueue();
    const id = await confirmed(A, q, codes(`ISO${tag}`, 3));
    expect((await row(id)).companyId).toBe(A.companyId);
    expect((await row(id)).status).toBe('PROCESSING');
    expect(q.jobs.get(`import-${id}`)?.state).toBe('waiting');
    expect(await tenantPrisma.run(B.companyId, (tx) => tx.importJob.count({ where: { id } }))).toBe(0);
  });

  it('2+3. divergence (a) job missing, (b) job left completed while row PROCESSING: sweep resumes to DONE', async () => {
    const q = new FakeBullQueue();
    const missing = await confirmed(A, q, codes(`DVM${tag}`, 3));
    const zombie = await confirmed(A, q, codes(`DVZ${tag}`, 3));
    loseJob(q, missing);
    q.setState(`import-${zombie}`, 'completed'); // D1: worker "completed" (no-op run) but the import never finished
    await recovery(q).sweep(FUTURE(), A.companyId);
    for (const id of [missing, zombie]) {
      expect((await row(id)).attemptCount).toBe(1);
      expect(q.jobs.get(`import-${id}`)?.state).toBe('waiting');
      await runWorker(q, A, id);
      expect((await row(id)).status).toBe('DONE');
    }
    expect(await countCustomers(A, `DVM${tag}`)).toBe(3);
    expect(await countCustomers(A, `DVZ${tag}`)).toBe(3);
  });

  it('4. cursor preserved after real mid-commit crash: customers + products, no duplicates by code/sku, counters cumulative', async () => {
    for (const type of ['customers', 'products'] as const) {
      const q = new FakeBullQueue();
      const prefix = `CUR${type[0].toUpperCase()}${tag}`;
      const id = await confirmed(A, q, codes(prefix, 450), type);
      const method = type === 'customers' ? 'commitCustomers' : 'commitProducts';
      const original = (processor as unknown as Record<string, (...a: unknown[]) => unknown>)[method].bind(processor);
      const spy = vi.spyOn(processor as never, method as never);
      let calls = 0;
      spy.mockImplementation(((...args: unknown[]) => {
        if (++calls === 2) throw new Error('crash mid-import');
        return original(...args);
      }) as never);
      await expect(processor.process({ data: { importJobId: id, companyId: A.companyId }, opts: { attempts: 3 }, attemptsMade: 0 } as unknown as Job<ImportJobData>)).rejects.toThrow('crash mid-import');
      spy.mockRestore();
      const mid = await row(id);
      expect(mid.status).toBe('PROCESSING');
      expect((mid.errorLog as { commit: { nextIndex: number } }).commit.nextIndex).toBe(200);
      expect(type === 'customers' ? await countCustomers(A, prefix) : await countProducts(A, prefix)).toBe(200);

      q.setState(`import-${id}`, 'completed'); // BullMQ gave up/finished, row still PROCESSING
      await recovery(q).sweep(FUTURE(), A.companyId);
      await runWorker(q, A, id);
      const done = await row(id);
      expect(done.status).toBe('DONE');
      expect(type === 'customers' ? await countCustomers(A, prefix) : await countProducts(A, prefix)).toBe(450);
      const log = done.errorLog as { createdCount: number; skippedCount: number };
      expect(log.createdCount).toBe(450);
      expect(log.skippedCount).toBe(0); // resumed at cursor, earlier rows not re-visited as "already exists"
    }
  }, 120_000);

  it('5. limit exhaustion -> FAILED IMPORT_RECOVERY_EXHAUSTED; no infinite loop, attemptCount never > max, rows+cursor kept', async () => {
    const q = new FakeBullQueue();
    let adds = 0;
    const counting = Object.assign(Object.create(q), { add: async (...a: Parameters<FakeBullQueue['add']>) => { adds++; return q.add(...a); } });
    const id = await confirmed(A, q, codes(`LIM${tag}`, 3));
    const max = importRecoveryMaxAttempts();
    const attempts: number[] = [];
    for (let i = 0; i < max + 6; i++) {
      loseJob(q, id); // the job keeps vanishing: would loop forever without the bound
      await recovery(counting).sweep(FUTURE(), A.companyId);
      attempts.push((await row(id)).attemptCount);
    }
    const r = await row(id);
    expect(r.status).toBe('FAILED');
    expect((r.errorLog as { code: string }).code).toBe('IMPORT_RECOVERY_EXHAUSTED');
    expect(Math.max(...attempts)).toBeLessThanOrEqual(max);
    expect(adds).toBe(max);
    expect(q.jobs.has(`import-${id}`)).toBe(false); // further sweeps are no-ops
    expect(((r.errorLog as { rows?: unknown[] }).rows ?? []).length).toBe(3);
    expect(await tenantPrisma.run(A.companyId, (tx) => tx.auditLog.count({ where: { action: 'import.failed_recovery_exhausted', entityId: id } }))).toBe(1);
  });

  it('6. one job erroring inside the sweep does not stop the others (getJob and add failures)', async () => {
    const q = new FakeBullQueue();
    const ids = [await confirmed(A, q, [`ERR${tag}-1`]), await confirmed(A, q, [`ERR${tag}-2`]), await confirmed(A, q, [`ERR${tag}-3`])];
    ids.forEach((id) => loseJob(q, id));
    const flaky = Object.assign(Object.create(q), {
      getJob: async (id: string) => {
        if (id === `import-${ids[0]}`) throw new Error('boom getJob');
        return q.getJob(id);
      },
      add: async (n: string, d: unknown, o: { jobId: string }) => {
        if (o.jobId === `import-${ids[1]}`) throw new Error('boom add');
        return q.add(n, d, o);
      },
    });
    await recovery(flaky).sweep(FUTURE(), A.companyId);
    expect((await row(ids[0])).attemptCount).toBe(0);
    expect((await row(ids[1])).attemptCount).toBe(0); // released
    expect((await row(ids[2])).attemptCount).toBe(1);
    expect(q.jobs.get(`import-${ids[2]}`)?.state).toBe('waiting');
  });

  it('7. parallel sweeps over several companies: each job claimed exactly once per backoff window', async () => {
    const q = new FakeBullQueue();
    let adds = 0;
    const counting = Object.assign(Object.create(q), { add: async (...a: Parameters<FakeBullQueue['add']>) => { adds++; return q.add(...a); } });
    const jobs: string[] = [];
    for (const ctx of [A, B, C]) for (let i = 0; i < 2; i++) jobs.push(await confirmed(ctx, q, [`PS${tag}-${ctx.user.lastName}${i}`]));
    jobs.forEach((id) => loseJob(q, id));
    const now = new Date(Date.now() + 310_000); // just past the first 300s backoff, well inside the second (600s) window
    for (let wave = 0; wave < 2; wave++) await Promise.all([A, B, C].flatMap((c) => [recovery(counting).sweep(now, c.companyId), recovery(counting).sweep(now, c.companyId), recovery(counting).sweep(now, c.companyId)]));
    for (const id of jobs) expect((await row(id)).attemptCount).toBe(1);
    expect(adds).toBe(jobs.length);
  });

  it('8. cross-tenant: A sweep/retry cannot touch B', async () => {
    const q = new FakeBullQueue();
    const bJob = await confirmed(B, q, [`XT${tag}-B`]);
    loseJob(q, bJob);
    const before = await row(bJob);
    await recovery(q).sweep(FUTURE(), A.companyId);
    const after = await row(bJob);
    expect(after.attemptCount).toBe(0);
    expect(q.jobs.has(`import-${bJob}`)).toBe(false);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    // exhaust B's job, then try the operator retry under A's company id
    await tenantPrisma.run(B.companyId, (tx) => tx.importJob.update({ where: { id: bJob }, data: { attemptCount: importRecoveryMaxAttempts() } }));
    await recovery(q).sweep(FUTURE(), B.companyId);
    expect((await row(bJob)).status).toBe('FAILED');
    await expect(retryImportJob({ companyId: A.companyId, jobId: bJob, reason: 'x', operator: 't', dryRun: false }, q.asQueue<ImportJobData>())).rejects.toThrow(/not found/);
    expect((await row(bJob)).status).toBe('FAILED');
    expect(q.jobs.has(`import-${bJob}`)).toBe(false);
    expect(await tenantPrisma.run(A.companyId, (tx) => tx.importJob.count({ where: { id: bJob } }))).toBe(0);
  });

  it('9. Redis unavailable (getJob throws, or add throws): no status/attempt/updatedAt change, no audit', async () => {
    const q = new FakeBullQueue();
    const id = await confirmed(A, q, [`RDS${tag}-1`]);
    loseJob(q, id);
    const before = await row(id);
    const downGet = Object.assign(Object.create(q), { getJob: async () => { throw new Error('ECONNREFUSED'); } });
    const downAdd = Object.assign(Object.create(q), { add: async () => { throw new Error('ECONNREFUSED'); } });
    await recovery(downGet).sweep(FUTURE(), A.companyId);
    await recovery(downAdd).sweep(FUTURE(), A.companyId);
    const r = await row(id);
    expect(r.status).toBe('PROCESSING');
    expect(r.attemptCount).toBe(0);
    expect(q.jobs.has(`import-${id}`)).toBe(false);
    expect(r.errorLog).toEqual(before.errorLog);
    expect(await tenantPrisma.run(A.companyId, (tx) => tx.auditLog.count({ where: { entityId: id, action: { startsWith: 'import.failed' } } }))).toBe(0);
  });

  it('10. terminal DONE/FAILED rows are never re-executed or re-enqueued', async () => {
    const q = new FakeBullQueue();
    const done = await confirmed(A, q, codes(`TRM${tag}`, 2));
    await runWorker(q, A, done);
    const failed = await confirmed(A, q, [`TRF${tag}-1`]);
    await tenantPrisma.run(A.companyId, (tx) => tx.importJob.update({ where: { id: failed }, data: { status: 'FAILED', errorLog: { ...IMPORT_COMMIT_FAILED } } }));
    const snap = [await row(done), await row(failed)];
    [done, failed].forEach((id) => loseJob(q, id));
    await recovery(q).sweep(FUTURE(), A.companyId);
    await processor.process({ data: { importJobId: done, companyId: A.companyId } } as unknown as Job<ImportJobData>);
    await processor.process({ data: { importJobId: failed, companyId: A.companyId } } as unknown as Job<ImportJobData>);
    expect(q.jobs.size).toBe(0);
    expect(await countCustomers(A, `TRM${tag}`)).toBe(2);
    expect(await countCustomers(A, `TRF${tag}`)).toBe(0);
    const now = [await row(done), await row(failed)];
    now.forEach((r, i) => {
      expect(r.status).toBe(snap[i].status);
      expect(r.attemptCount).toBe(0);
      expect(r.updatedAt.getTime()).toBe(snap[i].updatedAt.getTime());
    });
  });

  describe('legacy reproduction (pre-fix sweep from a8d5d91^, test-local copy)', () => {
    /** Verbatim logic of the pre-ADR-064 sweep: only 'missing' -> add, only 'failed' -> FAILED; 'completed' falls through; no attemptCount, no backoff. */
    async function legacySweep(q: FakeBullQueue, companyId: string): Promise<number> {
      const stuck = await systemPrisma.importJob.findMany({ where: { status: 'PROCESSING', companyId }, select: { id: true, companyId: true, createdBy: true } });
      let touched = 0;
      for (const j of stuck) {
        const queued = await q.getJob(`import-${j.id}`);
        const state = queued ? await queued.getState() : 'missing';
        if (state === 'missing') {
          await addTracedJob(q.asQueue<ImportJobData>(), 'commit', { importJobId: j.id, companyId: j.companyId, userId: j.createdBy ?? undefined }, { ...IMPORT_JOB_OPTS, jobId: `import-${j.id}` });
          touched++;
        }
      }
      return touched;
    }

    it('D1: completed entry + PROCESSING row stays PROCESSING forever under legacy; fixed sweep reaches DONE', async () => {
      const q = new FakeBullQueue();
      const id = await confirmed(A, q, codes(`LGD${tag}`, 2));
      q.setState(`import-${id}`, 'completed');
      for (let i = 0; i < 5; i++) expect(await legacySweep(q, A.companyId)).toBe(0);
      expect((await row(id)).status).toBe('PROCESSING'); // stranded: the defect
      expect(q.jobs.get(`import-${id}`)?.state).toBe('completed');

      await recovery(q).sweep(FUTURE(), A.companyId);
      await runWorker(q, A, id);
      expect((await row(id)).status).toBe('DONE');
    });

    it('unbounded re-enqueue under legacy (attemptCount never moves); fixed sweep caps at max', async () => {
      const q = new FakeBullQueue();
      let adds = 0;
      const counting = Object.assign(Object.create(q), { add: async (...a: Parameters<FakeBullQueue['add']>) => { adds++; return q.add(...a); }, asQueue: () => counting });
      const id = await confirmed(A, q, [`LGU${tag}-1`]);
      const max = importRecoveryMaxAttempts();
      for (let i = 0; i < max + 4; i++) {
        loseJob(q, id);
        await legacySweep(counting as FakeBullQueue, A.companyId);
      }
      expect(adds).toBe(max + 4); // more than max, no bound
      expect((await row(id)).attemptCount).toBe(0);
      expect((await row(id)).status).toBe('PROCESSING');

      adds = 0;
      for (let i = 0; i < max + 4; i++) {
        loseJob(q, id);
        await recovery(counting).sweep(FUTURE(), A.companyId);
      }
      expect(adds).toBeLessThanOrEqual(max); // legacy already used queue; bounded by remaining attempts
      expect((await row(id)).status).toBe('FAILED');
    });
  });

});
