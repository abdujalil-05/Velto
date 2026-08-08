import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { InvoiceStatus, PaymentMethod, prisma, systemPrisma } from '@velto/database';
import type { StorageService } from '../../../common/storage/storage.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import type { Export1cJobData } from './export-1c.constants';
import { Export1cProcessor } from './export-1c.processor';

describe('Export1cProcessor (integration, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function createCompany() {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-export1c-proc-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Export1c Processor Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Export1c Processor Test Co' } });
    return company.id;
  }

  async function seedFixtures(companyId: string, opts: { withExternalCode: boolean }) {
    return tenantPrisma.run(companyId, async (tx) => {
      const customer = await tx.customer.create({
        data: { companyId, code: `C-${randomUUID().slice(0, 8)}`, name: 'Test Customer' },
      });
      const product = await tx.product.create({
        data: {
          companyId,
          sku: `SKU-${randomUUID().slice(0, 8)}`,
          name: 'Test Product',
          baseUnit: 'dona',
          externalCode: opts.withExternalCode ? '1C-CODE-001' : null,
        },
      });
      const invoice = await tx.invoice.create({
        data: {
          companyId,
          number: `INV-TEST-${randomUUID().slice(0, 8)}`,
          customerId: customer.id,
          total: '150000',
          status: InvoiceStatus.OPEN,
          lines: { create: [{ productId: product.id, qty: '10', unitPrice: '15000', vatRate: '12', lineTotal: '150000' }] },
        },
      });
      await tx.payment.create({
        data: { companyId, number: `PAY-TEST-${randomUUID().slice(0, 8)}`, customerId: customer.id, amount: '150000', method: PaymentMethod.CASH },
      });
      return { customerId: customer.id, productId: product.id, invoiceId: invoice.id };
    });
  }

  async function createPendingJob(companyId: string, format: 'XML' | 'EXCEL') {
    return tenantPrisma.run(companyId, (tx) =>
      tx.exportJob.create({
        data: {
          companyId,
          type: '1c',
          format,
          status: 'PENDING',
          periodFrom: new Date(Date.now() - 86_400_000),
          periodTo: new Date(Date.now() + 86_400_000),
        },
      }),
    );
  }

  function fakeJob(exportJobId: string, companyId: string): Job<Export1cJobData> {
    return { data: { exportJobId, companyId } } as unknown as Job<Export1cJobData>;
  }

  it('generates a CommerceML XML file, uploads it, and marks the job DONE with no warnings', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createPendingJob(companyId, 'XML');

    const upload = vi.fn().mockResolvedValue('https://storage.test/exports/1c/file.xml');
    const processor = new Export1cProcessor(tenantPrisma, { upload } as unknown as StorageService);

    await processor.process(fakeJob(exportJob.id, companyId));

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('DONE');
    expect(updated.fileUrl).toBe('https://storage.test/exports/1c/file.xml');
    expect(updated.errorLog).toBeNull();
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'application/xml', extension: 'xml' }));

    const uploadedXml = (upload.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(uploadedXml).toContain('<Документ>');
    expect(uploadedXml).toContain('1C-CODE-001');
  });

  it('still succeeds but records a warning when a product is missing externalCode', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: false });
    const exportJob = await createPendingJob(companyId, 'XML');

    const upload = vi.fn().mockResolvedValue('https://storage.test/file.xml');
    const processor = new Export1cProcessor(tenantPrisma, { upload } as unknown as StorageService);
    await processor.process(fakeJob(exportJob.id, companyId));

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('DONE');
    expect(updated.errorLog).toEqual(
      expect.objectContaining({ warnings: expect.arrayContaining([expect.stringContaining('externalCode')]) }),
    );
  });

  it('marks the job FAILED and records the error when the upload step throws', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createPendingJob(companyId, 'XML');

    const upload = vi.fn().mockRejectedValue(new Error('S3 is down'));
    const processor = new Export1cProcessor(tenantPrisma, { upload } as unknown as StorageService);

    await expect(processor.process(fakeJob(exportJob.id, companyId))).rejects.toThrow('S3 is down');

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('FAILED');
    expect(updated.errorLog).toEqual(expect.objectContaining({ message: 'S3 is down' }));
  });

  it('unwraps an AggregateError (e.g. S3 connection refused) instead of recording an empty message', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createPendingJob(companyId, 'XML');

    // This is exactly the shape Node/undici throws for a refused connection:
    // AggregateError.message is "", the useful text is in .errors.
    const connectionError = new AggregateError(
      [Object.assign(new Error('connect ECONNREFUSED ::1:9000'), { code: 'ECONNREFUSED' })],
      '',
    );
    const upload = vi.fn().mockRejectedValue(connectionError);
    const processor = new Export1cProcessor(tenantPrisma, { upload } as unknown as StorageService);

    await expect(processor.process(fakeJob(exportJob.id, companyId))).rejects.toThrow();

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('FAILED');
    expect(updated.errorLog).toEqual(expect.objectContaining({ message: expect.stringContaining('ECONNREFUSED') }));
  });

  it('builds an Excel workbook (not XML) when format=EXCEL', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createPendingJob(companyId, 'EXCEL');

    const upload = vi.fn().mockResolvedValue('https://storage.test/file.xlsx');
    const processor = new Export1cProcessor(tenantPrisma, { upload } as unknown as StorageService);
    await processor.process(fakeJob(exportJob.id, companyId));

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
  });

  it('is a no-op when the export job no longer exists (e.g. deleted before the worker ran)', async () => {
    const companyId = await createCompany();
    const upload = vi.fn();
    const processor = new Export1cProcessor(tenantPrisma, { upload } as unknown as StorageService);

    await expect(processor.process(fakeJob(randomUUID(), companyId))).resolves.toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });
});
