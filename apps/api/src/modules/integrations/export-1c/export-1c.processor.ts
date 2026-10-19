import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { InvoiceStatus, Prisma, type ExportFormat, type TenantClient } from '@velto/database';
import { runJobWithTrace } from '../../../common/queue/trace-job';
import { StorageService } from '../../../common/storage/storage.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { buildCommerceMlXml, type CommerceMlCustomer, type CommerceMlDocument } from './commerce-ml';
import { buildExport1cWorkbook, type PaymentDocumentRow, type SalesDocumentRow } from './export-1c-excel';
import { buildExport1cCsv, type CsvDocument } from './export-1c-csv';
import { companyDay } from '../../field/company-day';
import { EXPORT_1C_MAPPING_VERSION, EXPORT_1C_QUEUE, export1cStorageKey, type Export1cJobData } from './export-1c.constants';
import { paymentPostedAt, paymentPostedWithin } from '../../finance/ledger-filters';

/**
 * Network/connection failures (e.g. S3 unreachable) surface from the AWS SDK
 * as an `AggregateError` whose own `.message` is empty — the useful text is
 * nested one level down in `.errors`. Without unwrapping this, a failed
 * upload would leave the accountant looking at `{ "message": "" }` with no
 * way to tell what actually went wrong.
 */
function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors.map((e) => describeError(e)).join('; ');
    return inner || err.message || err.name;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return err.message || (code ? `${err.name}: ${code}` : err.name);
  }
  return String(err);
}

interface ExportData {
  customers: CommerceMlCustomer[];
  documents: CommerceMlDocument[];
  salesDocuments: SalesDocumentRow[];
  payments: PaymentDocumentRow[];
  csvDocuments: CsvDocument[];
  missingExternalCode: string[];
}

/**
 * 11.1: consumes `1c-export` jobs enqueued by Export1cService. Runs
 * in-process inside apps/api (see common/queue/queue.module.ts) rather than
 * a separate worker app. Each phase gets its own short `tenantPrisma.run()`
 * transaction instead of holding one open across the whole job — the
 * XML/Excel build and S3 upload are non-trivial I/O that shouldn't happen
 * inside a DB transaction.
 */
@Processor(EXPORT_1C_QUEUE)
export class Export1cProcessor extends WorkerHost {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly storage: StorageService,
  ) {
    super();
  }

  process(job: Job<Export1cJobData>): Promise<void> {
    return runJobWithTrace(job, () => this.handle(job));
  }

  private async handle(job: Job<Export1cJobData>): Promise<void> {
    const { exportJobId, companyId } = job.data;

    // Idempotency: only a QUEUED job is picked up. Redelivery of a job that is
    // already PROCESSING/GENERATED/FAILED (or acknowledged) is a no-op.
    const exportJob = await this.tenantPrisma.run(companyId, async (tx) => {
      // Atomic compare-and-set: of two workers / a redelivery only one wins and bumps attemptCount.
      const { count } = await tx.exportJob.updateMany({ where: { id: exportJobId, status: 'QUEUED' }, data: { status: 'PROCESSING', attemptCount: { increment: 1 } } });
      if (count !== 1) return null;
      return tx.exportJob.findFirst({ where: { id: exportJobId } });
    });
    if (!exportJob) return;

    try {
      // One REPEATABLE READ snapshot: invoices, payments and customers must be mutually consistent.
      const data = await this.tenantPrisma.run(
        companyId,
        async (tx) => {
          const company = await tx.company.findFirst({ select: { timezone: true } });
          return this.loadExportData(tx, exportJob.periodFrom, exportJob.periodTo, company?.timezone ?? 'Asia/Tashkent');
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

      const { buffer, mimeType, extension } = await this.render(exportJob.format, data);
      const storageKey = export1cStorageKey(companyId, exportJobId, extension);
      // Deterministic key: a retry overwrites the same object, so no orphan files.
      await this.storage.putObject({ key: storageKey, buffer, mimeType });
      const fileHash = createHash('sha256').update(buffer).digest('hex');

      // Guarded: if the sweep already FAILED this job, write nothing (the deterministic key is overwritten by a later export of the same job id; none exists).
      await this.tenantPrisma.run(companyId, (tx) =>
        tx.exportJob.updateMany({
          where: { id: exportJobId, status: 'PROCESSING' },
          data: {
            status: 'GENERATED',
            storageKey,
            fileName: `1c-export-${exportJob.periodFrom.toISOString().slice(0, 10)}_${exportJob.periodTo.toISOString().slice(0, 10)}.${extension}`,
            fileSize: buffer.length,
            fileHash,
            recordCount: data.documents.length,
            mappingVersion: EXPORT_1C_MAPPING_VERSION,
            generatedAt: new Date(),
            // Non-fatal: still a successful export, but the accountant needs
            // to know these lines won't match cleanly in 1C (11.1: "Product.
            // externalCode maydoni majburiy") until product data is fixed.
            errorLog:
              data.missingExternalCode.length > 0
                ? { warnings: data.missingExternalCode.map((sku) => `Mahsulot "${sku}" uchun externalCode kiritilmagan`) }
                : Prisma.DbNull,
          },
        }),
      );
    } catch (err) {
      // Only the last attempt is terminal; earlier ones go back to QUEUED so BullMQ's retry can run.
      const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
      await this.tenantPrisma.run(companyId, (tx) =>
        tx.exportJob.updateMany({
          where: { id: exportJobId, status: 'PROCESSING' },
          data: { status: isLastAttempt ? 'FAILED' : 'QUEUED', errorLog: { message: describeError(err) } },
        }),
      );
      throw err; // BullMQ retries (backoff) or records the failure
    }
  }

  private async render(format: ExportFormat, data: ExportData): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
    if (format === 'EXCEL') {
      return { buffer: await buildExport1cWorkbook(data), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
    }
    if (format === 'CSV') {
      return { buffer: buildExport1cCsv(data.csvDocuments), mimeType: 'text/csv; charset=utf-8', extension: 'csv' };
    }
    return {
      buffer: Buffer.from(buildCommerceMlXml({ generatedAt: new Date(), customers: data.customers, documents: data.documents, currency: 'UZS' }), 'utf-8'),
      mimeType: 'application/xml',
      extension: 'xml',
    };
  }

  /** 11.1: "Eksport qilinadi: kontragentlar, sotish hujjatlari, to'lovlar" — sales documents are Invoices (6.6: "1 order = 1 invoice soddalashtirilgan"), not SalesOrders, since those are the actual accounting-facing documents. */
  private async loadExportData(tx: TenantClient, periodFrom: Date, periodTo: Date, timeZone: string): Promise<ExportData> {
    const [invoices, payments] = await Promise.all([
      tx.invoice.findMany({
        where: { createdAt: { gte: periodFrom, lte: periodTo }, status: { not: InvoiceStatus.CANCELLED } },
        include: { customer: true, lines: { include: { product: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      tx.payment.findMany({
        // REVERSED payments are never exported as ordinary payments (no storno document in MVP).
        // ADR-029: period/date = paymentPostedAt (accepted handover -> handoverAt);
        // PENDING_HANDOVER/REJECTED never reach 1C.
        where: { ...paymentPostedWithin({ gte: periodFrom, lte: periodTo }), status: 'POSTED' },
        include: { customer: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const customersById = new Map<string, CommerceMlCustomer>();
    const missingExternalCode = new Set<string>();
    const documents: CommerceMlDocument[] = [];
    const csvDocuments: CsvDocument[] = [];
    const day = (d: Date) => companyDay(d, timeZone).date;

    const toCommerceMlCustomer = (c: { id: string; code: string; name: string; phone: string | null }): CommerceMlCustomer => ({
      id: c.id,
      code: c.code,
      name: c.name,
      phone: c.phone,
    });

    for (const invoice of invoices) {
      customersById.set(invoice.customer.id, toCommerceMlCustomer(invoice.customer));

      documents.push({
        id: invoice.id,
        number: invoice.number,
        date: invoice.createdAt,
        operation: 'Отгрузка товара',
        customerId: invoice.customerId,
        total: invoice.total.toString(),
        lines: invoice.lines.map((line) => {
          if (!line.product.externalCode) missingExternalCode.add(line.product.sku);
          return {
            externalCode: line.product.externalCode,
            sku: line.product.sku,
            productName: line.product.name,
            qty: line.qty.toString(),
            unitPrice: line.unitPrice.toString(),
            lineTotal: line.lineTotal.toString(),
          };
        }),
      });
    }

    for (const invoice of invoices) {
      csvDocuments.push({
        docType: 'SALE',
        id: invoice.id,
        number: invoice.number,
        date: day(invoice.createdAt),
        partnerCode: invoice.customer.code,
        partnerName: invoice.customer.name,
        total: invoice.total.toString(),
        method: '',
        lines: invoice.lines.map((l) => ({ sku: l.product.sku, externalCode: l.product.externalCode, qty: l.qty.toString(), unitPrice: l.unitPrice.toString(), lineTotal: l.lineTotal.toString() })),
      });
    }

    for (const payment of payments) {
      csvDocuments.push({
        docType: 'PAYMENT',
        id: payment.id,
        number: payment.number,
        date: day(paymentPostedAt(payment)),
        partnerCode: payment.customer.code,
        partnerName: payment.customer.name,
        total: payment.amount.toString(),
        method: payment.method,
        lines: [],
      });
    }

    for (const payment of payments) {
      customersById.set(payment.customer.id, toCommerceMlCustomer(payment.customer));

      documents.push({
        id: payment.id,
        number: payment.number,
        date: paymentPostedAt(payment),
        operation: 'Оплата от покупателя',
        customerId: payment.customerId,
        total: payment.amount.toString(),
      });
    }

    return {
      customers: [...customersById.values()],
      documents,
      salesDocuments: invoices.map((i) => ({ id: i.id, number: i.number, date: i.createdAt, customerName: i.customer.name, total: i.total.toString() })),
      payments: payments.map((p) => ({ id: p.id, number: p.number, date: paymentPostedAt(p), customerName: p.customer.name, amount: p.amount.toString(), method: p.method })),
      csvDocuments,
      missingExternalCode: [...missingExternalCode],
    };
  }
}
