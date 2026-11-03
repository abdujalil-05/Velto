import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { FakeBullQueue } from '../../common/queue/fake-bull-queue';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { StorageService } from '../../common/storage/storage.service';
import { IMPORT_MANUAL_RETRY_AUDIT_ACTION, parseRetryImportJobArgs, retryImportJob } from '../../scripts/retry-import-job';
import { ScopedImportRecoveryService } from './scoped-import-recovery';
import { importRecoveryMaxAttempts, type ImportJobData } from './import.constants';
import { ImportService } from './import.service';
import { buildTestWorkbook } from './parsers/test-workbook';

/** scripts/retry-import-job.ts exported function on synthetic jobs (test DB only; assert-test-db refuses velto_dev). */
describe('retryImportJob (operator retry of IMPORT_RECOVERY_EXHAUSTED)', () => {
  const tenantPrisma = new TenantPrismaService();
  const storage = { upload: vi.fn().mockResolvedValue('https://storage.test/imports/f.xlsx') } as unknown as StorageService;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  type Ctx = { companyId: string; user: AuthenticatedUser; ownerPhone: string; staffId: string };
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function makeCompany(label: string): Promise<Ctx> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-imp-rty-${label}-${randomUUID().slice(0, 8)}`, name: `Import Retry ${label}` } });
    const companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Import Retry Co ${label}` } })).id;
    const ownerPhone = `+99891${Math.floor(1e6 + Math.random() * 9e6)}`;
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'Own', lastName: label, phone: ownerPhone } });
    const staff = await systemPrisma.user.create({ data: { companyId, firstName: 'Stf', lastName: label, phone: `+99892${Math.floor(1e6 + Math.random() * 9e6)}` } });
    const owner = await systemPrisma.role.create({ data: { companyId, name: 'Admin', code: 'OWNER', isSystem: true } });
    const clerk = await systemPrisma.role.create({ data: { companyId, name: 'Clerk', code: 'WAREHOUSE', isSystem: true } });
    await systemPrisma.userRole.create({ data: { userId: u.id, roleId: owner.id } });
    await systemPrisma.userRole.create({ data: { userId: staff.id, roleId: clerk.id } });
    return { companyId, ownerPhone, staffId: staff.id, user: { id: u.id, companyId, firstName: 'Own', lastName: label, roles: ['OWNER'], permissions: ['settings.update'] } };
  }
  const row = (id: string) => systemPrisma.importJob.findUniqueOrThrow({ where: { id } });
  const asQ = (q: FakeBullQueue) => q.asQueue<ImportJobData>() as Queue<ImportJobData>;

  /** Confirmed import (PROCESSING, rows in errorLog), with a commit cursor + 1 already-imported customer, then exhausted by the sweep. */
  async function exhausted(ctx: Ctx, q: FakeBullQueue, p: string) {
    const list = [`${p}-0`, `${p}-1`, `${p}-2`];
    const buf = await buildTestWorkbook(['code', 'name'], list.map((c) => [c, `N ${c}`]));
    const svc = new ImportService(tenantPrisma, storage, asQ(q), new AuditLogService());
    const created = await tenantPrisma.run(ctx.companyId, () => svc.uploadAndValidate('customers', buf, ctx.user));
    await tenantPrisma.run(ctx.companyId, () => svc.confirm(created.id, ctx.user));
    const cursor = { nextIndex: 1, createdCount: 1, skippedCount: 0, errors: [] };
    await tenantPrisma.run(ctx.companyId, async (tx) => {
      await tx.customer.create({ data: { companyId: ctx.companyId, code: list[0], name: `N ${list[0]}` } as never });
      await tx.$executeRaw`UPDATE "ImportJob" SET "errorLog" = COALESCE("errorLog", '{}'::jsonb) || ${JSON.stringify({ commit: cursor })}::jsonb, "attemptCount" = ${importRecoveryMaxAttempts()} WHERE "id" = ${created.id}::uuid`;
    });
    q.jobs.delete(`import-${created.id}`);
    await new ScopedImportRecoveryService(tenantPrisma, asQ(q)).sweep(new Date(Date.now() + 48 * 3600_000), ctx.companyId);
    expect((await row(created.id)).status).toBe('FAILED');
    return { id: created.id, cursor, list };
  }
  const audits = (companyId: string, id: string) => systemPrisma.auditLog.findMany({ where: { companyId, entityId: id, action: IMPORT_MANUAL_RETRY_AUDIT_ACTION } });
  const args = (c: Ctx, jobId: string, o: Partial<{ operator: string; reason: string; dryRun: boolean; companyId: string }> = {}) => ({ companyId: c.companyId, jobId, reason: 'ops ticket 42', operator: c.ownerPhone, dryRun: false, ...o });

  it('dry-run changes nothing (row, queue, audit)', async () => {
    const A = await makeCompany('dry');
    const q = new FakeBullQueue();
    const { id } = await exhausted(A, q, `DRY${tag}`);
    const before = await row(id);
    const res = await retryImportJob(args(A, id, { dryRun: true }), asQ(q));
    expect(res.dryRun).toBe(true);
    const after = await row(id);
    expect(after.status).toBe('FAILED');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(q.jobs.has(`import-${id}`)).toBe(false);
    expect(await audits(A.companyId, id)).toHaveLength(0);
  });

  it('allowed retry: PROCESSING + enqueued, cursor/rows kept, imported rows kept, audit has operator/company/reason/traceId', async () => {
    const A = await makeCompany('ok');
    const q = new FakeBullQueue();
    const { id, cursor, list } = await exhausted(A, q, `OK${tag}`);
    const before = await row(id);
    const res = await retryImportJob(args(A, id), asQ(q));
    expect(res.attemptCount).toBe(importRecoveryMaxAttempts());
    const after = await row(id);
    expect(after.status).toBe('PROCESSING');
    expect(after.attemptCount).toBe(before.attemptCount); // not reset
    const log = after.errorLog as { commit?: unknown; rows?: unknown[]; code?: string };
    expect(log.commit).toEqual(cursor);
    expect(log.rows).toHaveLength(list.length);
    expect(log.code).toBeUndefined();
    expect(q.jobs.has(`import-${id}`)).toBe(true);
    expect((q.jobs.get(`import-${id}`)!.data as ImportJobData).companyId).toBe(A.companyId);
    expect(await tenantPrisma.run(A.companyId, (tx) => tx.customer.count({ where: { code: list[0] } }))).toBe(1);
    const [a, ...rest] = await audits(A.companyId, id);
    expect(rest).toHaveLength(0);
    expect(a.companyId).toBe(A.companyId);
    expect(a.userId).toBe(A.user.id);
    expect(a.traceId).toBeTruthy();
    const nv = a.newValue as Record<string, unknown>;
    expect(nv).toMatchObject({ actor: 'operator-asserted', operatorUserId: A.user.id, reason: 'ops ticket 42' });
    expect(nv.osUser).toBeTruthy();
    expect(nv.host).toBeTruthy();
  });

  it('operator may be given by user id; second run is refused (no longer FAILED/EXHAUSTED)', async () => {
    const A = await makeCompany('id');
    const q = new FakeBullQueue();
    const { id } = await exhausted(A, q, `ID${tag}`);
    await retryImportJob(args(A, id, { operator: A.user.id }), asQ(q));
    await expect(retryImportJob(args(A, id), asQ(q))).rejects.toThrow(/Refusing/);
    expect(await audits(A.companyId, id)).toHaveLength(1);
  });

  it('rejects: other company job, non-EXHAUSTED job, empty reason, unverified/non-owner/foreign/inactive operator', async () => {
    const A = await makeCompany('rj-a');
    const B = await makeCompany('rj-b');
    const q = new FakeBullQueue();
    const { id: aJob } = await exhausted(A, q, `RJA${tag}`);
    // other company's job
    await expect(retryImportJob(args(B, aJob), asQ(q))).rejects.toThrow(/not found/);
    // non-EXHAUSTED: PROCESSING row
    const svc = new ImportService(tenantPrisma, storage, asQ(q), new AuditLogService());
    const buf = await buildTestWorkbook(['code', 'name'], [[`RJP${tag}`, 'n']]);
    const created = await tenantPrisma.run(A.companyId, () => svc.uploadAndValidate('customers', buf, A.user));
    await tenantPrisma.run(A.companyId, () => svc.confirm(created.id, A.user));
    await expect(retryImportJob(args(A, created.id), asQ(q))).rejects.toThrow(/only FAILED\/IMPORT_RECOVERY_EXHAUSTED/);
    // FAILED with a different code
    await tenantPrisma.run(A.companyId, (tx) => tx.importJob.update({ where: { id: created.id }, data: { status: 'FAILED', errorLog: { code: 'IMPORT_COMMIT_FAILED' } } }));
    await expect(retryImportJob(args(A, created.id), asQ(q))).rejects.toThrow(/IMPORT_COMMIT_FAILED/);
    // missing reason (parser + function)
    expect(() => parseRetryImportJobArgs(['--company', A.companyId, '--job', aJob, '--operator', 'x'])).toThrow(/required/);
    await expect(retryImportJob(args(A, aJob, { reason: '  ' }), asQ(q))).rejects.toThrow(/reason/);
    // operator checks
    await expect(retryImportJob(args(A, aJob, { operator: 'free text name' }), asQ(q))).rejects.toThrow(/active OWNER/);
    await expect(retryImportJob(args(A, aJob, { operator: A.staffId }), asQ(q))).rejects.toThrow(/active OWNER/); // not OWNER
    await expect(retryImportJob(args(A, aJob, { operator: B.user.id }), asQ(q))).rejects.toThrow(/active OWNER/); // other company's owner
    await systemPrisma.user.update({ where: { id: A.user.id }, data: { isActive: false } });
    await expect(retryImportJob(args(A, aJob), asQ(q))).rejects.toThrow(/active OWNER/);
    // nothing changed
    expect((await row(aJob)).status).toBe('FAILED');
    expect(q.jobs.has(`import-${aJob}`)).toBe(false);
    expect(await audits(A.companyId, aJob)).toHaveLength(0);
  });
});
