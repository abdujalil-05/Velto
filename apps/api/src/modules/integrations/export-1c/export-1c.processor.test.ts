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

  async function createQueuedJob(companyId: string, format: 'XML' | 'EXCEL' | 'CSV') {
    return tenantPrisma.run(companyId, (tx) =>
      tx.exportJob.create({
        data: {
          companyId,
          type: '1c',
          format,
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
    const exportJob = await createQueuedJob(companyId, 'XML');

    const upload = vi.fn().mockResolvedValue('k');
    const processor = new Export1cProcessor(tenantPrisma, { putObject: upload } as unknown as StorageService);

    await processor.process(fakeJob(exportJob.id, companyId));

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('GENERATED');
    expect(updated.storageKey).toBe(`exports/1c/${companyId}/${exportJob.id}.xml`);
    expect(updated.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updated.recordCount).toBe(2);
    expect(updated.mappingVersion).toBe(1);
    expect(updated.attemptCount).toBe(1);
    expect(updated.fileUrl).toBeNull();
    expect(updated.errorLog).toBeNull();
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'application/xml' }));

    const uploadedXml = (upload.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(uploadedXml).toContain('<Документ>');
    expect(uploadedXml).toContain('1C-CODE-001');
  });

  it('still succeeds but records a warning when a product is missing externalCode', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: false });
    const exportJob = await createQueuedJob(companyId, 'XML');

    const upload = vi.fn().mockResolvedValue('https://storage.test/file.xml');
    const processor = new Export1cProcessor(tenantPrisma, { putObject: upload } as unknown as StorageService);
    await processor.process(fakeJob(exportJob.id, companyId));

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('GENERATED');
    expect(updated.errorLog).toEqual(
      expect.objectContaining({ warnings: expect.arrayContaining([expect.stringContaining('externalCode')]) }),
    );
  });

  it('marks the job FAILED and records the error when the upload step throws', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createQueuedJob(companyId, 'XML');

    const upload = vi.fn().mockRejectedValue(new Error('S3 is down'));
    const processor = new Export1cProcessor(tenantPrisma, { putObject: upload } as unknown as StorageService);

    await expect(processor.process(fakeJob(exportJob.id, companyId))).rejects.toThrow('S3 is down');

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('FAILED');
    expect(updated.errorLog).toEqual(expect.objectContaining({ message: 'S3 is down' }));
  });

  it('unwraps an AggregateError (e.g. S3 connection refused) instead of recording an empty message', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createQueuedJob(companyId, 'XML');

    // This is exactly the shape Node/undici throws for a refused connection:
    // AggregateError.message is "", the useful text is in .errors.
    const connectionError = new AggregateError(
      [Object.assign(new Error('connect ECONNREFUSED ::1:9000'), { code: 'ECONNREFUSED' })],
      '',
    );
    const upload = vi.fn().mockRejectedValue(connectionError);
    const processor = new Export1cProcessor(tenantPrisma, { putObject: upload } as unknown as StorageService);

    await expect(processor.process(fakeJob(exportJob.id, companyId))).rejects.toThrow();

    const updated = await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));
    expect(updated.status).toBe('FAILED');
    expect(updated.errorLog).toEqual(expect.objectContaining({ message: expect.stringContaining('ECONNREFUSED') }));
  });

  it('builds an Excel workbook (not XML) when format=EXCEL', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createQueuedJob(companyId, 'EXCEL');

    const upload = vi.fn().mockResolvedValue('https://storage.test/file.xlsx');
    const processor = new Export1cProcessor(tenantPrisma, { putObject: upload } as unknown as StorageService);
    await processor.process(fakeJob(exportJob.id, companyId));

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
  });

  it('exports only POSTED payments; REVERSED ones are excluded (CommerceML and Excel)', async () => {
    const companyId = await createCompany();
    const { customerId } = await seedFixtures(companyId, { withExternalCode: true });
    const postedNo = (await tenantPrisma.run(companyId, (tx) => tx.payment.findFirstOrThrow({ where: { status: 'POSTED' } }))).number;
    const reversedNo = `PAY-REV-${randomUUID().slice(0, 8)}`;
    await tenantPrisma.run(companyId, async (tx) => {
      // DB triggers: insert POSTED only; REVERSED only after its PaymentReversal row.
      const p = await tx.payment.create({ data: { companyId, number: reversedNo, customerId, amount: '777', method: PaymentMethod.CASH } });
      const actor = await tx.user.create({ data: { companyId, firstName: 'Rev', lastName: 'Actor', phone: `+99896${Math.floor(1_000_000 + Math.random() * 8_999_999)}` } });
      await tx.paymentReversal.create({ data: { companyId, reversesPaymentId: p.id, reason: 'test', actorId: actor.id } });
      await tx.payment.update({ where: { id: p.id }, data: { status: 'REVERSED' } });
    });

    const xmlUpload = vi.fn().mockResolvedValue('https://storage.test/f.xml');
    await new Export1cProcessor(tenantPrisma, { putObject: xmlUpload } as unknown as StorageService).process(
      fakeJob((await createQueuedJob(companyId, 'XML')).id, companyId),
    );
    const xml = (xmlUpload.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(xml).toContain(postedNo);
    expect(xml).not.toContain(reversedNo);

    const xlsUpload = vi.fn().mockResolvedValue('https://storage.test/f.xlsx');
    await new Export1cProcessor(tenantPrisma, { putObject: xlsUpload } as unknown as StorageService).process(
      fakeJob((await createQueuedJob(companyId, 'EXCEL')).id, companyId),
    );
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((xlsUpload.mock.calls[0]![0] as { buffer: Buffer }).buffer as never);
    const numbers = wb.getWorksheet("To'lovlar")!.getSheetValues().flat().map(String);
    expect(numbers).toContain(postedNo);
    expect(numbers).not.toContain(reversedNo);
  });

  it('is a no-op when the export job no longer exists (e.g. deleted before the worker ran)', async () => {
    const companyId = await createCompany();
    const upload = vi.fn();
    const processor = new Export1cProcessor(tenantPrisma, { putObject: upload } as unknown as StorageService);

    await expect(processor.process(fakeJob(randomUUID(), companyId))).resolves.toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });

  const TASHKENT_ISO = /^\d{4}-\d{2}-\d{2}$/;

  it('retries: intermediate failure goes PROCESSING -> QUEUED, success on attempt 3 yields one file with one hash', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createQueuedJob(companyId, 'CSV');
    const putObject = vi.fn().mockRejectedValueOnce(new Error('boom1')).mockRejectedValueOnce(new Error('boom2')).mockResolvedValue('k');
    const processor = new Export1cProcessor(tenantPrisma, { putObject } as unknown as StorageService);
    const attempt = (n: number) => ({ data: { exportJobId: exportJob.id, companyId }, attemptsMade: n, opts: { attempts: 3 } }) as unknown as Job<Export1cJobData>;
    const read = () => tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }));

    await expect(processor.process(attempt(0))).rejects.toThrow('boom1');
    expect((await read()).status).toBe('QUEUED');
    await expect(processor.process(attempt(1))).rejects.toThrow('boom2');
    expect((await read()).status).toBe('QUEUED');
    await processor.process(attempt(2));

    const done = await read();
    expect(done.status).toBe('GENERATED');
    expect(done.attemptCount).toBe(3);
    const keys = new Set(putObject.mock.calls.map((c) => (c[0] as { key: string }).key));
    expect(keys.size).toBe(1); // deterministic key: retries overwrite, no orphan files
    const { createHash } = await import('node:crypto');
    const buf = (putObject.mock.calls[2]![0] as { buffer: Buffer }).buffer;
    expect(done.fileHash).toBe(createHash('sha256').update(buf).digest('hex'));
    expect(done.fileSize).toBe(buf.length);
  });

  it('final attempt failure marks FAILED; a redelivered job for a non-QUEUED export is a no-op', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createQueuedJob(companyId, 'CSV');
    const putObject = vi.fn().mockRejectedValue(new Error('down'));
    const processor = new Export1cProcessor(tenantPrisma, { putObject } as unknown as StorageService);
    const last = { data: { exportJobId: exportJob.id, companyId }, attemptsMade: 2, opts: { attempts: 3 } } as unknown as Job<Export1cJobData>;
    await expect(processor.process(last)).rejects.toThrow('down');
    expect((await tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } }))).status).toBe('FAILED');
    putObject.mockClear();
    await processor.process(last);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('CSV: UTF-8 BOM, CRLF, flat columns, Tashkent-day dates', async () => {
    const companyId = await createCompany();
    await seedFixtures(companyId, { withExternalCode: true });
    const exportJob = await createQueuedJob(companyId, 'CSV');
    const putObject = vi.fn().mockResolvedValue('k');
    await new Export1cProcessor(tenantPrisma, { putObject } as unknown as StorageService).process(fakeJob(exportJob.id, companyId));
    const text = (putObject.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('docType,Ид,number,date,partnerCode,partnerName,sku,externalCode,qty,unitPrice,lineTotal,total,method');
    const sale = lines.find((l) => l.startsWith('SALE,'))!.split(',');
    expect(sale[3]).toMatch(TASHKENT_ISO);
    expect(sale[7]).toBe('1C-CODE-001');
    expect(sale[8]).toBe('10');
    expect(lines.find((l) => l.startsWith('PAYMENT,'))).toMatch(/,CASH$/);
  });

  it('CSV: Ид (document UUID) is stable across two exports of 80 documents', async () => {
    const companyId = await createCompany();
    const { customerId, productId } = await seedFixtures(companyId, { withExternalCode: true });
    await tenantPrisma.run(companyId, async (tx) => {
      for (let i = 0; i < 79; i++) {
        await tx.invoice.create({
          data: {
            companyId, number: `INV-BULK-${i}-${randomUUID().slice(0, 6)}`, customerId, total: '100', status: InvoiceStatus.OPEN,
            lines: { create: [{ productId, qty: '1', unitPrice: '100', vatRate: '12', lineTotal: '100' }] },
          },
        });
      }
    });
    const run = async () => {
      const job = await createQueuedJob(companyId, 'CSV');
      const putObject = vi.fn().mockResolvedValue('k');
      await new Export1cProcessor(tenantPrisma, { putObject } as unknown as StorageService).process(fakeJob(job.id, companyId));
      const rows = (putObject.mock.calls[0]![0] as { buffer: Buffer }).buffer.toString('utf-8').slice(1).split('\r\n').filter(Boolean).slice(1);
      return rows.map((r) => r.split(',').slice(0, 3).join('|')).sort();
    };
    const first = await run();
    const second = await run();
    expect(first.filter((r) => r.startsWith('SALE|')).length).toBe(80);
    expect(second).toEqual(first);
  });
});
