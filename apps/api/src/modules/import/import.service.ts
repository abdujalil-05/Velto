import { AppException } from '../../common/errors/app-exception';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { getTraceId } from '../../common/trace/trace-context';
import type { Queue } from 'bullmq';
import { Prisma, type TenantClient } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { paginate } from '../../common/pagination/pagination.dto';
import { StorageService } from '../../common/storage/storage.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { ListImportsQueryDto } from './dto/list-imports.query';
import { ImportAlreadyConfirmedException, ImportJobNotFoundException, ImportQueueUnavailableException, InvalidImportFileException } from './import-exceptions';
import { addTracedJobReplacingTerminal } from '../../common/queue/trace-job';
import { localizeRowErrors } from './row-messages';
import { IMPORT_JOB_OPTS, IMPORT_QUEUE, IMPORT_TYPES, type ImportJobData, type ImportJobReport, type ImportType } from './import.constants';
import { parseCustomersWorkbook, type CustomerImportRow } from './parsers/customers-parser';
import { parseProductsWorkbook, type ProductImportRow } from './parsers/products-parser';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 9.2/11.1 M15: "/import ... Shablon yuklab olish -> fayl yuklash -> validatsiya xatolari jadvali -> tasdiqlash". */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly storage: StorageService,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue<ImportJobData>,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Uploads the raw file (audit record, matching ImportJob.fileUrl being required) then validates it synchronously — 1000-2000 rows (11.4) is fast enough not to need a queue for this half of the flow. */
  async uploadAndValidate(type: ImportType, buffer: Buffer, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    const fileUrl = await this.storage.upload({
      buffer,
      mimeType: XLSX_MIME,
      extension: 'xlsx',
      keyPrefix: `imports/${type}/${user.companyId}`,
    });

    // Not persisted as a FAILED job: this whole method already runs inside
    // the caller's tenantPrisma.run() transaction (the request-scoped one
    // from TenantContextInterceptor), so a create() here would be rolled
    // back the instant this catch re-throws — Prisma's $transaction() rolls
    // back the entire callback when it throws, including writes already
    // made earlier in that same callback. Matches file-validation.ts's
    // controller-level rejection, which likewise persists nothing.
    let report: ImportJobReport<CustomerImportRow | ProductImportRow>;
    try {
      report = type === 'customers' ? await this.validateCustomers(tx, buffer) : await this.validateProducts(tx, buffer);
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw new InvalidImportFileException('could not parse workbook — check it matches the template');
    }

    return tx.importJob.create({
      data: {
        companyId: user.companyId,
        type,
        status: 'PENDING',
        fileUrl,
        createdBy: user.id,
        progress: 0,
        errorLog: report as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async validateCustomers(tx: TenantClient, buffer: Buffer): Promise<ImportJobReport<CustomerImportRow>> {
    const existing = await tx.customer.findMany({ where: { deletedAt: null }, select: { code: true } });
    const existingCodes = new Set(existing.map((c) => c.code));
    const { totalRows, validRows, errors } = await parseCustomersWorkbook(buffer, existingCodes);
    return { totalRows, validCount: validRows.length, invalidCount: errors.length, errors: localizeRowErrors(errors), rows: validRows };
  }

  private async validateProducts(tx: TenantClient, buffer: Buffer): Promise<ImportJobReport<ProductImportRow>> {
    const existing = await tx.product.findMany({ where: { deletedAt: null }, select: { sku: true } });
    const existingSkus = new Set(existing.map((p) => p.sku));
    // TZ 6.6: blank vatRate cells take the tenant's Company.defaultVatRate.
    const company = await tx.company.findFirst({ select: { defaultVatRate: true } });
    const defaultVatRate = company ? Number(company.defaultVatRate) : 12;
    const { totalRows, validRows, errors } = await parseProductsWorkbook(buffer, existingSkus, defaultVatRate);
    return { totalRows, validCount: validRows.length, invalidCount: errors.length, errors: localizeRowErrors(errors), rows: validRows };
  }

  async list(query: ListImportsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.ImportJobWhereInput = { type: query.type ?? { in: IMPORT_TYPES } };
    const [data, total] = await Promise.all([
      tx.importJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.importJob.count({ where }),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const job = await this.tenantPrisma.client.importJob.findFirst({ where: { id, type: { in: IMPORT_TYPES } } });
    if (!job) throw new ImportJobNotFoundException();
    return job;
  }

  /**
   * Only a freshly validated (PENDING) job can be confirmed. The PENDING ->
   * PROCESSING transition is a single conditional UPDATE (row lock), so two
   * concurrent confirms cannot both win; the loser gets 409. Valid rows only
   * are written (invalid/existing rows stay in the report) — see processor.
   */
  async confirm(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const job = await tx.importJob.findFirst({ where: { id, type: { in: IMPORT_TYPES } } });
    if (!job) throw new ImportJobNotFoundException();

    const { count } = await tx.importJob.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'PROCESSING', progress: 0 } });
    if (count !== 1) throw new ImportAlreadyConfirmedException();

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'import.confirm',
      entity: 'ImportJob',
      entityId: id,
      newValue: toAuditJson({ type: job.type }),
    });
    // Deferred until this request's transaction actually commits — same
    // enqueue-before-commit race as Export1cService.create(). Fixed jobId
    // makes a duplicate enqueue a no-op in BullMQ.
    TenantContext.afterCommit(async () => {
      try {
        await addTracedJobReplacingTerminal(this.queue, 'commit', { importJobId: id, companyId: user.companyId, userId: user.id }, { ...IMPORT_JOB_OPTS, jobId: `import-${id}` });
      } catch (err) {
        this.logger.error(`import ${id}: enqueue failed (${err instanceof Error ? err.name : 'error'}) trace=${getTraceId() ?? '-'}`);
        // Revert so the user can confirm again instead of a stuck PROCESSING job.
        await this.tenantPrisma.run(user.companyId, (t) =>
          t.importJob.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'PENDING', progress: 0 } }),
        );
        throw new ImportQueueUnavailableException();
      }
    });
    return tx.importJob.findFirstOrThrow({ where: { id } });
  }
}
