import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
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
    expect(report.errors).toContainEqual({ row: 2, messages: ['code "C-RACE" allaqachon mavjud'] });
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
});
