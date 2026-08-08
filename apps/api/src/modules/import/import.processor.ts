import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { IMPORT_QUEUE, type ImportJobData, type ImportJobReport, type RowError } from './import.constants';
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
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super();
  }

  async process(job: Job<ImportJobData>): Promise<void> {
    const { importJobId, companyId } = job.data;

    try {
      await this.tenantPrisma.run(companyId, async (tx) => {
        const importJob = await tx.importJob.findFirst({ where: { id: importJobId } });
        if (!importJob) return; // job/company mismatch — nothing to commit

        const stored = importJob.errorLog as unknown as ImportJobReport<CustomerImportRow | ProductImportRow> | null;
        const rows = stored?.rows ?? [];

        const result =
          importJob.type === 'customers'
            ? await this.commitCustomers(tx, companyId, rows as CustomerImportRow[])
            : await this.commitProducts(tx, companyId, rows as ProductImportRow[]);

        await this.auditLog.log(tx, {
          companyId,
          action: importJob.type === 'customers' ? 'customer.import' : 'product.import',
          entity: importJob.type === 'customers' ? 'Customer' : 'Product',
          entityId: importJob.id,
          newValue: toAuditJson(result),
        });

        const finalReport: ImportJobReport<never> = {
          totalRows: stored?.totalRows ?? rows.length,
          validCount: stored?.validCount ?? rows.length,
          invalidCount: stored?.invalidCount ?? 0,
          errors: [...(stored?.errors ?? []), ...result.errors],
          createdCount: result.createdCount,
          skippedCount: result.skippedCount,
        };

        await tx.importJob.update({
          where: { id: importJobId },
          data: { status: 'DONE', errorLog: finalReport as unknown as Prisma.InputJsonValue },
        });
      });
    } catch (err) {
      await this.tenantPrisma.run(companyId, (tx) =>
        tx.importJob.update({
          where: { id: importJobId },
          data: { status: 'FAILED', errorLog: { message: err instanceof Error ? err.message : String(err) } },
        }),
      );
      throw err;
    }
  }

  private async commitCustomers(tx: TenantClient, companyId: string, rows: CustomerImportRow[]): Promise<CommitResult> {
    let createdCount = 0;
    const errors: RowError[] = [];

    for (const row of rows) {
      const clash = await tx.customer.findFirst({ where: { code: row.code, deletedAt: null } });
      if (clash) {
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

  private async commitProducts(tx: TenantClient, companyId: string, rows: ProductImportRow[]): Promise<CommitResult> {
    let createdCount = 0;
    const errors: RowError[] = [];
    const categoryIdByName = new Map<string, string>();

    for (const row of rows) {
      const clash = await tx.product.findFirst({ where: { sku: row.sku, deletedAt: null } });
      if (clash) {
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
