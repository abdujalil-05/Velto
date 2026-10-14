import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { getTraceId } from '../../common/trace/trace-context';
import { IMPORT_COMMIT_FAILED } from './import-exceptions';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import { runJobWithTrace } from '../../common/queue/trace-job';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { IMPORT_COMMIT_CHUNK, IMPORT_QUEUE, type ImportCommitState, type ImportJobData, type ImportJobReport, type RowError } from './import.constants';
import { localizeRowErrors } from './row-messages';
import type { CustomerImportRow } from './parsers/customers-parser';
import type { ProductImportRow } from './parsers/products-parser';

interface CommitResult {
  createdCount: number;
  skippedCount: number;
  errors: RowError[];
}

/**
 * Consumes `import-commit` jobs enqueued by ImportService.confirm(). Rows
 * were already validated during upload — see ImportJobReport's doc comment
 * for why they travel via ImportJob.errorLog instead of re-reading the
 * uploaded file. Each row still gets one last existence check immediately
 * before its create() (mirrors CustomersService/ProductsService's own
 * findFirst-then-create pattern) since time has passed since validation and
 * another request could have taken the same code/sku meanwhile.
 */
@Processor(IMPORT_QUEUE)
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super();
  }

  process(job: Job<ImportJobData>): Promise<void> {
    return runJobWithTrace(job, () => this.handle(job));
  }

  private async handle(job: Job<ImportJobData>): Promise<void> {
    const { importJobId, companyId, userId } = job.data;

    try {
      // Idempotency: only a PROCESSING job is worked on. A duplicate/redelivered
      // job for a DONE (or still PENDING/FAILED) import is a no-op.
      const importJob = await this.tenantPrisma.run(companyId, (tx) => tx.importJob.findFirst({ where: { id: importJobId } }));
      if (!importJob || importJob.status !== 'PROCESSING') return;

      const stored = importJob.errorLog as unknown as ImportJobReport<CustomerImportRow | ProductImportRow> | null;
      const rows = stored?.rows ?? [];
      const type = importJob.type;

      // Chunked + resumable: each chunk commits its rows AND the cursor
      // (errorLog.commit: nextIndex + running counters) in ONE transaction.
      // A retry after a partial failure resumes at nextIndex, so rows created
      // by an earlier attempt of this job are never re-visited (and never
      // reported as "already exists"), and the counters stay cumulative.
      const result: CommitResult = {
        createdCount: stored?.commit?.createdCount ?? 0,
        skippedCount: stored?.commit?.skippedCount ?? 0,
        errors: [...(stored?.commit?.errors ?? [])],
      };
      const categoryIdByName = new Map<string, string>();
      for (let i = stored?.commit?.nextIndex ?? 0; i < rows.length; i += IMPORT_COMMIT_CHUNK) {
        const chunk = rows.slice(i, i + IMPORT_COMMIT_CHUNK);
        const progress = Math.min(99, Math.floor(((i + chunk.length) / rows.length) * 100));
        const part = await this.tenantPrisma.run(companyId, async (tx) => {
          const r =
            type === 'customers'
              ? await this.commitCustomers(tx, companyId, chunk as CustomerImportRow[])
              : await this.commitProducts(tx, companyId, chunk as ProductImportRow[], categoryIdByName);
          const commit: ImportCommitState = {
            nextIndex: i + chunk.length,
            createdCount: result.createdCount + r.createdCount,
            skippedCount: result.skippedCount + r.skippedCount,
            errors: [...result.errors, ...r.errors],
          };
          // jsonb merge keeps the (large) stored rows untouched on the client side.
          await tx.$executeRaw`UPDATE "ImportJob" SET "progress" = ${progress}, "errorLog" = COALESCE("errorLog", '{}'::jsonb) || ${JSON.stringify({ commit })}::jsonb WHERE "id" = ${importJobId}::uuid`;
          return r;
        });
        result.createdCount += part.createdCount;
        result.skippedCount += part.skippedCount;
        result.errors.push(...part.errors);
      }

      await this.tenantPrisma.run(companyId, async (tx) => {
        await this.auditLog.log(tx, {
          companyId,
          userId,
          action: type === 'customers' ? 'customer.import' : 'product.import',
          entity: type === 'customers' ? 'Customer' : 'Product',
          entityId: importJob.id,
          newValue: toAuditJson(result),
        });

        const finalReport: ImportJobReport<never> = {
          totalRows: stored?.totalRows ?? rows.length,
          validCount: stored?.validCount ?? rows.length,
          invalidCount: stored?.invalidCount ?? 0,
          errors: [...(stored?.errors ?? []), ...localizeRowErrors(result.errors)],
          createdCount: result.createdCount,
          skippedCount: result.skippedCount,
        };

        await tx.importJob.update({
          where: { id: importJobId },
          data: { status: 'DONE', progress: 100, errorLog: finalReport as unknown as Prisma.InputJsonValue },
        });
      });
    } catch (err) {
      // Only the last attempt is terminal; earlier ones stay PROCESSING so the retry can run.
      const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
      if (isLastAttempt) {
        this.logger.error(`import ${importJobId}: commit failed trace=${getTraceId() ?? '-'}`, err instanceof Error ? err.stack : String(err));
        const cur = await this.tenantPrisma.run(companyId, (tx) => tx.importJob.findFirst({ where: { id: importJobId } }));
        const prev = (cur?.errorLog ?? {}) as unknown as Partial<ImportJobReport<never>>;
        await this.tenantPrisma.run(companyId, (tx) =>
          tx.importJob.update({
            where: { id: importJobId },
            data: {
              status: 'FAILED',
              errorLog: {
                totalRows: prev.totalRows,
                validCount: prev.validCount,
                invalidCount: prev.invalidCount,
                errors: prev.errors ?? [],
                createdCount: prev.commit?.createdCount ?? 0,
                skippedCount: prev.commit?.skippedCount ?? 0,
                ...IMPORT_COMMIT_FAILED,
              } as unknown as Prisma.InputJsonValue,
            },
          }),
        );
      }
      throw err;
    }
  }

  private async commitCustomers(tx: TenantClient, companyId: string, rows: CustomerImportRow[]): Promise<CommitResult> {
    let createdCount = 0;
    const errors: RowError[] = [];

    const taken = new Set(
      (await tx.customer.findMany({ where: { code: { in: rows.map((r) => r.code) }, deletedAt: null }, select: { code: true } })).map((c) => c.code),
    );

    for (const row of rows) {
      if (taken.has(row.code)) {
        errors.push({ row: row.rowNumber, messages: [`code "${row.code}" allaqachon mavjud`] });
        continue;
      }

      await tx.customer.create({
        data: {
          companyId,
          code: row.code,
          name: row.name,
          phone: row.phone,
          contactPerson: row.contactPerson,
          paymentTermDays: row.paymentTermDays,
          outlets: {
            create: [
              {
                companyId,
                name: row.outletName,
                address: row.outletAddress,
                latitude: row.outletLatitude,
                longitude: row.outletLongitude,
              },
            ],
          },
        },
      });
      createdCount++;
    }

    return { createdCount, skippedCount: errors.length, errors };
  }

  private async commitProducts(
    tx: TenantClient,
    companyId: string,
    rows: ProductImportRow[],
    categoryIdByName: Map<string, string>,
  ): Promise<CommitResult> {
    let createdCount = 0;
    const errors: RowError[] = [];
    const taken = new Set(
      (await tx.product.findMany({ where: { sku: { in: rows.map((r) => r.sku) }, deletedAt: null }, select: { sku: true } })).map((p) => p.sku),
    );

    for (const row of rows) {
      if (taken.has(row.sku)) {
        errors.push({ row: row.rowNumber, messages: [`sku "${row.sku}" allaqachon mavjud`] });
        continue;
      }

      let categoryId: string | undefined;
      if (row.categoryName) {
        const key = row.categoryName.toLowerCase();
        categoryId = categoryIdByName.get(key);
        if (!categoryId) {
          const existing = await tx.productCategory.findFirst({
            where: { name: { equals: row.categoryName, mode: 'insensitive' } },
          });
          const category = existing ?? (await tx.productCategory.create({ data: { companyId, name: row.categoryName } }));
          categoryId = category.id;
          categoryIdByName.set(key, categoryId);
        }
      }

      // 6.4: every product needs at least one packaging — the import row is
      // flat (no packaging columns), so a single default packaging matching
      // the product's own baseUnit (qty 1) is created; blok/quti variants
      // can be added afterwards through the regular Products screen.
      await tx.product.create({
        data: {
          companyId,
          sku: row.sku,
          name: row.name,
          brand: row.brand,
          baseUnit: row.baseUnit,
          categoryId,
          vatRate: row.vatRate,
          minPrice: row.minPrice,
          barcode: row.barcode,
          externalCode: row.externalCode,
          packagings: { create: [{ name: row.baseUnit, qtyInBaseUnit: 1, isDefault: true }] },
        },
      });
      createdCount++;
    }

    return { createdCount, skippedCount: errors.length, errors };
  }
}
