import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { ImportJobData, ImportJobReport } from './import.constants';
import { ImportProcessor } from './import.processor';
import type { CustomerImportRow } from './parsers/customers-parser';
import type { ProductImportRow } from './parsers/products-parser';

describe('ImportProcessor (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const processor = new ImportProcessor(tenantPrisma, new AuditLogService());

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function createCompany() {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-import-proc-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Import Processor Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Import Processor Test Co' } });
    return company.id;
  }

  async function createProcessingJob<T>(companyId: string, type: 'customers' | 'products', rows: T[]) {
    const report: ImportJobReport<T> = { totalRows: rows.length, validCount: rows.length, invalidCount: 0, errors: [], rows };
    return tenantPrisma.run(companyId, (tx) =>
      tx.importJob.create({
        data: { companyId, type, status: 'PROCESSING', fileUrl: 'https://storage.test/f.xlsx', errorLog: report as never },
      }),
    );
  }

  function fakeJob(importJobId: string, companyId: string): Job<ImportJobData> {
    return { data: { importJobId, companyId } } as unknown as Job<ImportJobData>;
  }

  it('creates a customer with its outlet for each valid row and marks the job DONE', async () => {
    const companyId = await createCompany();
    const rows: CustomerImportRow[] = [
      {
        rowNumber: 2,
        code: 'C-1',
        name: 'Test Customer',
        paymentTermDays: 7,
        outletName: 'Main Outlet',
        outletAddress: 'Tashkent',
        outletLatitude: 41.3,
        outletLongitude: 69.2,
      },
    ];
    const job = await createProcessingJob(companyId, 'customers', rows);

    await processor.process(fakeJob(job.id, companyId));

    const updated = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(updated.status).toBe('DONE');
    const report = updated.errorLog as unknown as ImportJobReport<never>;
    expect(report.createdCount).toBe(1);
    expect(report.skippedCount).toBe(0);
    expect(report.rows).toBeUndefined(); // dropped once committed

    const customer = await tenantPrisma.run(companyId, (tx) =>
      tx.customer.findFirstOrThrow({ where: { code: 'C-1' }, include: { outlets: true } }),
    );
    expect(customer.outlets).toHaveLength(1);
    expect(customer.outlets[0]!.name).toBe('Main Outlet');
  });

  it('skips a row whose code already exists by the time the job runs, and reports it', async () => {
    const companyId = await createCompany();
    await tenantPrisma.run(companyId, (tx) => tx.customer.create({ data: { companyId, code: 'C-RACE', name: 'Already Here' } }));

    const rows: CustomerImportRow[] = [
      { rowNumber: 2, code: 'C-RACE', name: 'Duplicate', paymentTermDays: 0, outletName: 'X' },
    ];
    const job = await createProcessingJob(companyId, 'customers', rows);
    await processor.process(fakeJob(job.id, companyId));

    const updated = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    const report = updated.errorLog as unknown as ImportJobReport<never>;
    expect(report.createdCount).toBe(0);
    expect(report.skippedCount).toBe(1);
    expect(report.errors).toContainEqual({
      row: 2,
      messages: ['code "C-RACE" allaqachon mavjud'],
      i18n: [expect.objectContaining({ uz: 'code "C-RACE" allaqachon mavjud', ru: expect.stringContaining('уже существует'), en: expect.stringContaining('already exists') })],
    });
  });

  it('creates a product with a default packaging, auto-creating a new category and reusing an existing one case-insensitively', async () => {
    const companyId = await createCompany();
    await tenantPrisma.run(companyId, (tx) => tx.productCategory.create({ data: { companyId, name: 'Ichimliklar' } }));

    const rows: ProductImportRow[] = [
      {
        rowNumber: 2,
        sku: 'SKU-1',
        name: 'New Category Product',
        categoryName: 'Yangi Kategoriya',
        baseUnit: 'dona',
        vatRate: 12,
        externalCode: 'SKU-1',
      },
      {
        rowNumber: 3,
        sku: 'SKU-2',
        name: 'Existing Category Product',
        categoryName: 'ICHIMLIKLAR',
        baseUnit: 'dona',
        vatRate: 12,
        externalCode: 'SKU-2',
      },
    ];
    const job = await createProcessingJob(companyId, 'products', rows);

    await processor.process(fakeJob(job.id, companyId));

    const updated = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    const report = updated.errorLog as unknown as ImportJobReport<never>;
    expect(report.createdCount).toBe(2);

    const categories = await tenantPrisma.run(companyId, (tx) => tx.productCategory.findMany());
    expect(categories.map((c) => c.name).sort()).toEqual(['Ichimliklar', 'Yangi Kategoriya']);

    const product1 = await tenantPrisma.run(companyId, (tx) =>
      tx.product.findFirstOrThrow({ where: { sku: 'SKU-1' }, include: { packagings: true, category: true } }),
    );
    expect(product1.packagings).toHaveLength(1);
    expect(product1.packagings[0]).toMatchObject({ name: 'dona', isDefault: true });
    expect(product1.category!.name).toBe('Yangi Kategoriya');

    const product2 = await tenantPrisma.run(companyId, (tx) =>
      tx.product.findFirstOrThrow({ where: { sku: 'SKU-2' }, include: { category: true } }),
    );
    expect(product2.category!.name).toBe('Ichimliklar'); // reused, not duplicated despite case difference
  });

  it('is a no-op when the import job no longer exists', async () => {
    const companyId = await createCompany();
    await expect(processor.process(fakeJob(randomUUID(), companyId))).resolves.toBeUndefined();
  });

  it('resumes after a partial failure: counters cumulative, no duplicates, own rows never reported as skipped', async () => {
    const companyId = await createCompany();
    const rows: CustomerImportRow[] = Array.from({ length: 1000 }, (_, k) => ({
      rowNumber: k + 2,
      code: `R-${k}`,
      name: `N${k}`,
      paymentTermDays: 0,
      outletName: 'O',
    }));
    const job = await createProcessingJob(companyId, 'customers', rows);

    // Fail the 3rd chunk's commit (after chunks 1-2 committed).
    const original = tenantPrisma.run.bind(tenantPrisma);
    let calls = 0;
    const spy = vi.spyOn(tenantPrisma, 'run').mockImplementation((async (cid: string, fn: never, opts?: never) => {
      calls++;
      if (calls === 4) throw new Error('boom: prisma internal text');
      return original(cid, fn, opts);
    }) as never);
    const failing = { data: { importJobId: job.id, companyId }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<ImportJobData>;
    await expect(processor.process(failing)).rejects.toThrow('boom');
    spy.mockRestore();

    const mid = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(mid.status).toBe('PROCESSING');
    expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count())).toBe(400);

    await processor.process(fakeJob(job.id, companyId));
    const done = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    const report = done.errorLog as unknown as ImportJobReport<never>;
    expect(done.status).toBe('DONE');
    expect(report.createdCount).toBe(1000);
    expect(report.skippedCount).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count())).toBe(1000);
  });

  it('chunk tx slower than its timeout rolls back atomically (cursor and rows together); retry resumes from the cursor, no double-creation', async () => {
    const companyId = await createCompany();
    const rows: CustomerImportRow[] = Array.from({ length: 600 }, (_, k) => ({ rowNumber: k + 2, code: `T-${k}`, name: `N${k}`, paymentTermDays: 0, outletName: 'O' }));
    const job = await createProcessingJob(companyId, 'customers', rows);
    const original = tenantPrisma.run.bind(tenantPrisma);
    let calls = 0;
    const spy = vi.spyOn(tenantPrisma, 'run').mockImplementation((async (cid: string, fn: (tx: never) => Promise<unknown>, opts?: never) => {
      calls++;
      // 4th run call = 3rd chunk: slow body vs. a 100 ms tx timeout (what Prisma's 5 s default did under load).
      if (calls === 4) return original(cid, async (tx) => { await new Promise((r) => setTimeout(r, 400)); return fn(tx as never); }, { timeout: 100, maxWait: 5000 } as never);
      return original(cid, fn as never, opts);
    }) as never);
    const failing = { data: { importJobId: job.id, companyId }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<ImportJobData>;
    await expect(processor.process(failing)).rejects.toThrow();
    spy.mockRestore();
    const mid = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(mid.status).toBe('PROCESSING');
    expect((mid.errorLog as unknown as ImportJobReport<never>).commit?.nextIndex).toBe(400); // rolled-back chunk left no cursor
    expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count())).toBe(400);
    await processor.process(fakeJob(job.id, companyId));
    const done = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(done.status).toBe('DONE');
    expect((done.errorLog as unknown as ImportJobReport<never>).createdCount).toBe(600);
    expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count())).toBe(600);
  });

  it('a run whose cursor is stale (another run advanced it) yields without writing', async () => {
    const companyId = await createCompany();
    const rows: CustomerImportRow[] = Array.from({ length: 300 }, (_, k) => ({ rowNumber: k + 2, code: `S-${k}`, name: `N${k}`, paymentTermDays: 0, outletName: 'O' }));
    const job = await createProcessingJob(companyId, 'customers', rows);
    const original = tenantPrisma.run.bind(tenantPrisma);
    let calls = 0;
    // After the processor loaded the job (call 1), simulate a concurrent run having advanced the cursor.
    const spy = vi.spyOn(tenantPrisma, 'run').mockImplementation((async (cid: string, fn: never, opts?: never) => {
      calls++;
      if (calls === 2) await original(cid, (tx) => tx.$executeRaw`UPDATE "ImportJob" SET "errorLog" = "errorLog" || '{"commit":{"nextIndex":200,"createdCount":200,"skippedCount":0,"errors":[]}}'::jsonb WHERE "id" = ${job.id}::uuid`);
      return original(cid, fn, opts);
    }) as never);
    await processor.process(fakeJob(job.id, companyId));
    spy.mockRestore();
    const after = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(after.status).toBe('PROCESSING');
    expect(await tenantPrisma.run(companyId, (tx) => tx.customer.count())).toBe(0);
  });

  it('on the last failed attempt stores a stable code + trilingual message, never the raw error text', async () => {
    const companyId = await createCompany();
    const job = await createProcessingJob(companyId, 'customers', [{ rowNumber: 2, code: 'F-1', name: 'x', paymentTermDays: 0, outletName: 'O' }] as CustomerImportRow[]);
    const original = tenantPrisma.run.bind(tenantPrisma);
    let calls = 0;
    const spy = vi.spyOn(tenantPrisma, 'run').mockImplementation((async (cid: string, fn: never, opts?: never) => {
      calls++;
      if (calls === 2) throw new Error('secret prisma detail');
      return original(cid, fn, opts);
    }) as never);
    const last = { data: { importJobId: job.id, companyId }, attemptsMade: 2, opts: { attempts: 3 } } as unknown as Job<ImportJobData>;
    await expect(processor.process(last)).rejects.toThrow();
    spy.mockRestore();
    const failed = await tenantPrisma.run(companyId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(failed.status).toBe('FAILED');
    expect(JSON.stringify(failed.errorLog)).not.toContain('secret prisma detail');
    expect(failed.errorLog).toMatchObject({ code: 'IMPORT_COMMIT_FAILED', message: { uz: expect.any(String), ru: expect.any(String), en: expect.any(String) } });
  });
});
