import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { StorageService } from '../../common/storage/storage.service';
import { ScopedImportRecoveryService } from './scoped-import-recovery';
import { IMPORT_QUEUE, importRecoveryMaxAttempts, type ImportJobData } from './import.constants';
import { ImportProcessor } from './import.processor';
import { ImportService } from './import.service';
import { buildTestWorkbook } from './parsers/test-workbook';

/** ADR-064b against REAL BullMQ/Redis (worker locks, stalled detection) + real Postgres/RLS. Own unique queue prefix, cleaned afterwards. */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const basePrefix = `adr064b-${randomUUID().slice(0, 8)}`;
let prefix = basePrefix; // per-test prefix: workers of one scenario never see another scenario's jobs

async function redisReachable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });
  r.on('error', () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
let reachable = false;

const FUTURE = (h = 24) => new Date(Date.now() + h * 3600_000);
/** Just past the first backoff (300 s) but inside the second (600 s): a real clock after the winner's CAS bumped updatedAt. */
const CLOSE = () => new Date(Date.now() + 310_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error('until: timeout');
}

describe('ADR-064b import recovery (real Redis/BullMQ + Postgres)', () => {
  const tenantPrisma = new TenantPrismaService();
  const audit = new AuditLogService();
  const processor = new ImportProcessor(tenantPrisma, audit);
  const storage = { upload: vi.fn().mockResolvedValue('https://storage.test/imports/f.xlsx') } as unknown as StorageService;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const conns: Redis[] = [];
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  type Ctx = { companyId: string; user: AuthenticatedUser };

  const mkConn = () => {
    const c = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    conns.push(c);
    return c;
  };
  const mkQueue = () => {
    const q = new Queue<ImportJobData>(IMPORT_QUEUE, { connection: mkConn(), prefix });
    queues.push(q);
    return q;
  };
  const mkWorker = (fn: (job: Job<ImportJobData>) => Promise<void>) => {
    const w = new Worker<ImportJobData>(IMPORT_QUEUE, fn, { connection: mkConn(), prefix, lockDuration: 1500, stalledInterval: 1000, maxStalledCount: 3, concurrency: 5 });
    w.on('error', () => undefined);
    workers.push(w);
    return w;
  };
  const recovery = (q: Queue<ImportJobData>) => new ScopedImportRecoveryService(tenantPrisma, q);
  const row = (id: string) => systemPrisma.importJob.findUniqueOrThrow({ where: { id } });
  const count = (c: Ctx, p: string) => tenantPrisma.run(c.companyId, (tx) => tx.customer.count({ where: { code: { startsWith: p } } }));

  async function makeCompany(label: string): Promise<Ctx> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-imp-rds-${label}-${randomUUID().slice(0, 8)}`, name: `Import Redis ${label}` } });
    const companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Import Redis Co ${label}` } })).id;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'R', lastName: label, phone: `+99890${Math.floor(1e6 + Math.random() * 9e6)}` } });
    return { companyId, user: { id: u.id, companyId, firstName: 'R', lastName: label, roles: ['OWNER'], permissions: ['settings.update'] } };
  }
  /** Real upload + confirm against the real queue -> PROCESSING row + BullMQ job `import-<id>` (waiting). */
  async function confirmed(ctx: Ctx, q: Queue<ImportJobData>, list: string[]): Promise<string> {
    const buf = await buildTestWorkbook(['code', 'name'], list.map((c) => [c, `N ${c}`]));
    const svc = new ImportService(tenantPrisma, storage, q, audit);
    const created = await tenantPrisma.run(ctx.companyId, () => svc.uploadAndValidate('customers', buf, ctx.user));
    await tenantPrisma.run(ctx.companyId, () => svc.confirm(created.id, ctx.user));
    return created.id;
  }
  const codes = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}-${String(i).padStart(4, '0')}`);
  const bullCount = async (q: Queue, id: string) => (await q.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized'])).filter((j) => j.id === `import-${id}`).length;

  beforeAll(async () => {
    reachable = await redisReachable();
    if (!reachable) console.warn(`[import-recovery-redis] SKIPPED: Redis unreachable at ${REDIS_URL}`);
  });
  /** Skips (loudly, see warning above) only when Redis is unreachable; asserts are never weakened. */
  const t = (name: string, fn: () => Promise<void>, timeout: number) =>
    it(name, async (ctx) => {
      if (!reachable) return ctx.skip();
      await fn();
    }, timeout);
  let n = 0;
  beforeEach(() => {
    prefix = `${basePrefix}-${n++}`;
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true).catch(() => undefined)));
  });
  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close(true).catch(() => undefined)));
    await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
    const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      let cursor = '0';
      do {
        const [next, keys] = await r.scan(cursor, 'MATCH', `${basePrefix}-*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await r.del(...keys);
      } while (cursor !== '0');
    } finally {
      r.disconnect();
    }
    conns.forEach((c) => c.disconnect());
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  t('(a) job active with a valid worker lock: concurrent sweeps neither remove nor re-add it', async () => {
    const A = await makeCompany('a');
    const q = mkQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const w = mkWorker(async () => {
      started++;
      await gate;
    });
    const id = await confirmed(A, q, codes(`LCK${tag}`, 2));
    await until(async () => (await (await q.getJob(`import-${id}`))?.getState()) === 'active');
    const before = await q.getJob(`import-${id}`);
    const tsBefore = before!.timestamp;
    const touched = await Promise.all([1, 2, 3, 4, 5].map(() => recovery(q).sweep(FUTURE(), A.companyId)));
    expect(touched).toEqual([0, 0, 0, 0, 0]);
    const after = await q.getJob(`import-${id}`);
    expect(await after!.getState()).toBe('active');
    expect(after!.timestamp).toBe(tsBefore);
    expect(started).toBe(1);
    const r = await row(id);
    expect(r.attemptCount).toBe(0);
    expect(r.status).toBe('PROCESSING');
    release();
    await w.close();
  }, 40_000);

  t('(b) worker crash / lock loss (stalled): redelivered and completed exactly once; sweeps never duplicate', async () => {
    const A = await makeCompany('b');
    const q = mkQueue();
    let calls = 0;
    const hang = new Promise<void>(() => undefined);
    const w1 = mkWorker(async () => {
      calls++;
      await hang; // crash: never finishes, never renews after force-close
    });
    const list = codes(`STL${tag}`, 5);
    const id = await confirmed(A, q, list);
    await until(async () => (await (await q.getJob(`import-${id}`))?.getState()) === 'active');
    await w1.close(true); // lock renewal stops; the lock expires after lockDuration
    await sleep(2000); // lock gone, job still sits in the active list
    expect(await recovery(q).sweep(FUTURE(), A.companyId)).toBe(0); // BullMQ still owns it (active) -> sweep must not add a 2nd copy
    expect(await bullCount(q, id)).toBe(1);
    expect((await row(id)).attemptCount).toBe(0);
    // a healthy worker with the stalled checker redelivers and finishes it via the REAL processor
    mkWorker(async (job) => {
      calls++;
      await processor.process(job);
    });
    await until(async () => (await row(id)).status === 'DONE');
    expect(calls).toBe(2); // 1 crashed + exactly 1 recovery run
    expect(await count(A, `STL${tag}`)).toBe(list.length); // no duplicate customers
    expect((await recovery(q).sweep(FUTURE(), A.companyId))).toBe(0);
    expect((await row(id)).attemptCount).toBe(0);
  }, 60_000);

  t('(b2) queue entry lost (Redis flush) -> recovered exactly once, then processed once', async () => {
    const A = await makeCompany('b2');
    const q = mkQueue();
    const list = codes(`LST${tag}`, 3);
    const id = await confirmed(A, q, list);
    await (await q.getJob(`import-${id}`))!.remove();
    expect(await recovery(q).sweep(FUTURE(), A.companyId)).toBe(1);
    const j = await q.getJob(`import-${id}`);
    expect(j?.data.companyId).toBe(A.companyId);
    expect((await row(id)).attemptCount).toBe(1);
    let calls = 0;
    mkWorker(async (job) => {
      calls++;
      await processor.process(job);
    });
    await until(async () => (await row(id)).status === 'DONE');
    expect(calls).toBe(1);
    expect(await count(A, `LST${tag}`)).toBe(list.length);
  }, 40_000);

  t('(c) N concurrent sweeps on a lost job: single CAS winner, exactly one BullMQ job', async () => {
    const A = await makeCompany('c');
    const q = mkQueue();
    const id = await confirmed(A, q, codes(`CON${tag}`, 2));
    await (await q.getJob(`import-${id}`))!.remove();
    const results = await Promise.all(Array.from({ length: 12 }, () => recovery(mkQueue()).sweep(CLOSE(), A.companyId)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await row(id)).attemptCount).toBe(1);
    expect(await bullCount(q, id)).toBe(1);
    expect(await q.getWaitingCount()).toBe(1);
  }, 40_000);

  t('(d) no infinite recovery: after max attempts the job is FAILED IMPORT_RECOVERY_EXHAUSTED, audited, nothing more enqueued', async () => {
    const A = await makeCompany('d');
    const q = mkQueue();
    const id = await confirmed(A, q, codes(`EXH${tag}`, 2));
    const max = importRecoveryMaxAttempts();
    let enqueues = 0;
    for (let i = 0; i < max + 3; i++) {
      await (await q.getJob(`import-${id}`))?.remove(); // lost again each time
      await recovery(q).sweep(FUTURE(48 + i), A.companyId);
      if (await q.getJob(`import-${id}`)) enqueues++;
    }
    const r = await row(id);
    expect(r.status).toBe('FAILED');
    expect((r.errorLog as { code?: string }).code).toBe('IMPORT_RECOVERY_EXHAUSTED');
    expect(r.attemptCount).toBe(max);
    expect(enqueues).toBe(max);
    expect(await bullCount(q, id)).toBe(0);
    const audits = await systemPrisma.auditLog.count({ where: { companyId: A.companyId, entityId: id, action: 'import.failed_recovery_exhausted' } });
    expect(audits).toBe(1);
  }, 60_000);

  t('(e) two companies: each job carries its own companyId, scoped sweeps never cross', async () => {
    const A = await makeCompany('e1');
    const B = await makeCompany('e2');
    const q = mkQueue();
    const a = await confirmed(A, q, codes(`XA${tag}`, 2));
    const b = await confirmed(B, q, codes(`XB${tag}`, 2));
    await (await q.getJob(`import-${a}`))!.remove();
    await (await q.getJob(`import-${b}`))!.remove();
    expect(await recovery(q).sweep(FUTURE(), A.companyId)).toBe(1);
    expect(await q.getJob(`import-${b}`)).toBeUndefined();
    expect((await row(b)).attemptCount).toBe(0);
    expect(await recovery(q).sweep(FUTURE(), B.companyId)).toBe(1);
    expect((await q.getJob(`import-${a}`))!.data.companyId).toBe(A.companyId);
    expect((await q.getJob(`import-${b}`))!.data.companyId).toBe(B.companyId);
    mkWorker((job) => processor.process(job));
    await until(async () => (await row(a)).status === 'DONE' && (await row(b)).status === 'DONE');
    expect(await count(A, `XA${tag}`)).toBe(2);
    expect(await count(A, `XB${tag}`)).toBe(0);
    expect(await count(B, `XB${tag}`)).toBe(2);
    expect(await count(B, `XA${tag}`)).toBe(0);
  }, 60_000);
});
