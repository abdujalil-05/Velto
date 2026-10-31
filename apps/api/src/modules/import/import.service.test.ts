import { AuditLogService } from '../../common/audit/audit-log.service';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { StorageService } from '../../common/storage/storage.service';
import { runWithTraceId } from '../../common/trace/trace-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { ImportAlreadyConfirmedException, ImportJobNotFoundException, ImportQueueUnavailableException, InvalidImportFileException } from './import-exceptions';
import type { ImportJobData, ImportJobReport } from './import.constants';
import { ImportService } from './import.service';
import { ImportRecoveryService } from './import-recovery.service';
import type { CustomerImportRow } from './parsers/customers-parser';
import { buildTestWorkbook } from './parsers/test-workbook';

describe('ImportService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;

  const tenantPrisma = new TenantPrismaService();
  const upload = vi.fn().mockResolvedValue('https://storage.test/imports/file.xlsx');
  const fakeStorage = { upload } as unknown as StorageService;
  const queueAdd = vi.fn().mockResolvedValue(undefined);
  const fakeQueue = { add: queueAdd, getJob: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<ImportJobData>;
  const importService = new ImportService(tenantPrisma, fakeStorage, fakeQueue, new AuditLogService());

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-import-${Date.now()}`, name: 'Import Test Tenant' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Import Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Owner', lastName: 'User', phone: '+998900000098' },
    });
    user = { id: dbUser.id, companyId, firstName: 'Owner', lastName: 'User', roles: ['OWNER'], permissions: ['settings.update'] };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const CUSTOMER_HEADERS = ['code', 'name'];

  it('uploads, validates, and stores a PENDING job with the validation report (rows included)', async () => {
    const buffer = await buildTestWorkbook(CUSTOMER_HEADERS, [['C-1', 'Test Customer']]);
    const job = await tenantPrisma.run(companyId, () => importService.uploadAndValidate('customers', buffer, user));

    expect(job.status).toBe('PENDING');
    expect(job.type).toBe('customers');
    expect(job.fileUrl).toBe('https://storage.test/imports/file.xlsx');

    const report = job.errorLog as unknown as ImportJobReport<CustomerImportRow>;
    expect(report.validCount).toBe(1);
    expect(report.invalidCount).toBe(0);
    expect(report.rows).toHaveLength(1);
  });

  it('throws (without persisting a job) when the uploaded file cannot be parsed as a workbook', async () => {
    const before = await tenantPrisma.run(companyId, (tx) => tx.importJob.count());

    const garbage = Buffer.from('not actually an xlsx file, just some bytes');
    await expect(tenantPrisma.run(companyId, () => importService.uploadAndValidate('customers', garbage, user))).rejects.toBeInstanceOf(
      InvalidImportFileException,
    );

    // No job row for this attempt: uploadAndValidate() runs inside the
    // caller's transaction, so anything it wrote before throwing would be
    // rolled back anyway (see the comment in import.service.ts) — it
    // correctly doesn't try.
    const after = await tenantPrisma.run(companyId, (tx) => tx.importJob.count());
    expect(after).toBe(before);
  });

  it('list() filters by type and getById() round-trips a created job', async () => {
    const buffer = await buildTestWorkbook(['sku', 'name', 'baseUnit'], [['SKU-1', 'Product', 'dona']]);
    const created = await tenantPrisma.run(companyId, () => importService.uploadAndValidate('products', buffer, user));

    const fetched = await tenantPrisma.run(companyId, () => importService.getById(created.id));
    expect(fetched.id).toBe(created.id);

    const productJobs = await tenantPrisma.run(companyId, () => importService.list({ type: 'products', page: 1, pageSize: 25 }));
    expect(productJobs.data.every((j) => j.type === 'products')).toBe(true);
    expect(productJobs.data.some((j) => j.id === created.id)).toBe(true);
  });

  it('getById() throws for an unknown id', async () => {
    await expect(tenantPrisma.run(companyId, () => importService.getById(randomUUID()))).rejects.toBeInstanceOf(ImportJobNotFoundException);
  });

  it('confirm() moves a PENDING job to PROCESSING and enqueues it; confirming twice fails', async () => {
    const buffer = await buildTestWorkbook(CUSTOMER_HEADERS, [['C-2', 'Another Customer']]);
    const created = await tenantPrisma.run(companyId, () => importService.uploadAndValidate('customers', buffer, user));

    const confirmed = await runWithTraceId('known-trace-id-123', () =>
      tenantPrisma.run(companyId, () => importService.confirm(created.id, user)),
    );
    expect(confirmed.status).toBe('PROCESSING');
    expect(queueAdd).toHaveBeenCalledWith('commit', { importJobId: created.id, companyId, userId: user.id, traceId: 'known-trace-id-123' }, expect.objectContaining({ jobId: `import-${created.id}`, attempts: 3 }));

    await expect(tenantPrisma.run(companyId, () => importService.confirm(created.id, user))).rejects.toBeInstanceOf(
      ImportAlreadyConfirmedException,
    );
  });

  it('confirm() reverts to PENDING and throws a trilingual 503 when enqueue fails; re-confirm then works', async () => {
    const buffer = await buildTestWorkbook(CUSTOMER_HEADERS, [['C-3', 'Third Customer']]);
    const created = await tenantPrisma.run(companyId, () => importService.uploadAndValidate('customers', buffer, user));

    queueAdd.mockRejectedValueOnce(new Error('ECONNREFUSED redis'));
    await expect(tenantPrisma.run(companyId, () => importService.confirm(created.id, user))).rejects.toBeInstanceOf(ImportQueueUnavailableException);
    const reverted = await tenantPrisma.run(companyId, () => importService.getById(created.id));
    expect(reverted.status).toBe('PENDING');

    const again = await tenantPrisma.run(companyId, () => importService.confirm(created.id, user));
    expect(again.status).toBe('PROCESSING');
  });

  it('recovery sweep re-enqueues a PROCESSING job missing from the queue (idempotent jobId)', async () => {
    const buffer = await buildTestWorkbook(CUSTOMER_HEADERS, [['C-4', 'Fourth']]);
    const created = await tenantPrisma.run(companyId, () => importService.uploadAndValidate('customers', buffer, user));
    await tenantPrisma.run(companyId, (tx) => tx.importJob.update({ where: { id: created.id }, data: { status: 'PROCESSING' } }));
    const add = vi.fn().mockResolvedValue(undefined);
    const recovery = new ImportRecoveryService(tenantPrisma, { add, getJob: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<ImportJobData>);
    await recovery.sweep();
    expect(add).toHaveBeenCalledWith('commit', expect.objectContaining({ importJobId: created.id, companyId }), expect.objectContaining({ jobId: `import-${created.id}` }));
    // do not leave PROCESSING residue in the shared dev DB
    await tenantPrisma.run(companyId, (tx) => tx.importJob.updateMany({ where: { id: created.id, status: 'PROCESSING' }, data: { status: 'FAILED' } }));
  });
});
