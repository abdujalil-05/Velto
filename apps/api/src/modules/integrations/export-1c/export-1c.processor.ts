import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InvoiceStatus, type TenantClient } from '@velto/database';
import { StorageService } from '../../../common/storage/storage.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { buildCommerceMlXml, type CommerceMlCustomer, type CommerceMlDocument } from './commerce-ml';
import { buildExport1cWorkbook, type PaymentDocumentRow, type SalesDocumentRow } from './export-1c-excel';
import { EXPORT_1C_QUEUE, type Export1cJobData } from './export-1c.constants';

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

  async process(job: Job<Export1cJobData>): Promise<void> {
    const { exportJobId, companyId } = job.data;

    const exportJob = await this.tenantPrisma.run(companyId, async (tx) => {
      const found = await tx.exportJob.findFirst({ where: { id: exportJobId } });
      if (!found) return null;
      await tx.exportJob.update({ where: { id: exportJobId }, data: { status: 'PROCESSING' } });
      return found;
    });
    if (!exportJob) return; // job/company mismatch — nothing to process

    try {
      const data = await this.tenantPrisma.run(companyId, (tx) => this.loadExportData(tx, exportJob.periodFrom, exportJob.periodTo));

      const { buffer, mimeType, extension } =
        exportJob.format === 'EXCEL'
          ? {
              buffer: await buildExport1cWorkbook(data),
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              extension: 'xlsx',
            }
          : {
              buffer: Buffer.from(
                buildCommerceMlXml({ generatedAt: new Date(), customers: data.customers, documents: data.documents, currency: 'UZS' }),
                'utf-8',
              ),
              mimeType: 'application/xml',
              extension: 'xml',
            };

      const fileUrl = await this.storage.upload({ buffer, mimeType, extension, keyPrefix: `exports/1c/${companyId}` });

      await this.tenantPrisma.run(companyId, (tx) =>
        tx.exportJob.update({
          where: { id: exportJobId },
          data: {
            status: 'DONE',
            fileUrl,
            // Non-fatal: still a successful export, but the accountant needs
            // to know these lines won't match cleanly in 1C (11.1: "Product.
            // externalCode maydoni majburiy") until product data is fixed.
            errorLog:
              data.missingExternalCode.length > 0
                ? { warnings: data.missingExternalCode.map((sku) => `Mahsulot "${sku}" uchun externalCode kiritilmagan`) }
                : undefined,
          },
        }),
      );
    } catch (err) {
      await this.tenantPrisma.run(companyId, (tx) =>
        tx.exportJob.update({
          where: { id: exportJobId },
          data: { status: 'FAILED', errorLog: { message: describeError(err) } },
        }),
      );
      throw err; // BullMQ still records the failure (retries/observability)
    }
  }

  /** 11.1: "Eksport qilinadi: kontragentlar, sotish hujjatlari, to'lovlar" — sales documents are Invoices (6.6: "1 order = 1 invoice soddalashtirilgan"), not SalesOrders, since those are the actual accounting-facing documents. */
  private async loadExportData(tx: TenantClient, periodFrom: Date, periodTo: Date): Promise<ExportData> {
    const [invoices, payments] = await Promise.all([
      tx.invoice.findMany({
        where: { createdAt: { gte: periodFrom, lte: periodTo }, status: { not: InvoiceStatus.CANCELLED } },
        include: { customer: true, lines: { include: { product: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      tx.payment.findMany({
        where: { createdAt: { gte: periodFrom, lte: periodTo } },
        include: { customer: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const customersById = new Map<string, CommerceMlCustomer>();
    const missingExternalCode = new Set<string>();
    const documents: CommerceMlDocument[] = [];

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

    for (const payment of payments) {
      customersById.set(payment.customer.id, toCommerceMlCustomer(payment.customer));

      documents.push({
        id: payment.id,
        number: payment.number,
        date: payment.createdAt,
        operation: 'Оплата от покупателя',
        customerId: payment.customerId,
        total: payment.amount.toString(),
      });
    }

    return {
      customers: [...customersById.values()],
      documents,
      salesDocuments: invoices.map((i) => ({ number: i.number, date: i.createdAt, customerName: i.customer.name, total: i.total.toString() })),
      payments: payments.map((p) => ({ number: p.number, date: p.createdAt, customerName: p.customer.name, amount: p.amount.toString(), method: p.method })),
      missingExternalCode: [...missingExternalCode],
    };
  }
}
