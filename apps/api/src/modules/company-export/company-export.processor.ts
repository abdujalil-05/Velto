import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { createReadStream } from 'node:fs';
import { Prisma } from '@velto/database';
import { runJobWithTrace } from '../../common/queue/trace-job';
import { StorageService } from '../../common/storage/storage.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { describeError } from '../integrations/export-1c/export-1c.processor';
import {
  COMPANY_EXPORT_MAPPING_VERSION,
  COMPANY_EXPORT_QUEUE,
  COMPANY_EXPORT_READ_TIMEOUT_MS,
  COMPANY_EXPORT_TYPE,
  XLSX_MIME,
  companyExportStorageKey,
  type CompanyExportJobData,
} from './company-export.constants';
import { writeCompanyWorkbook, type WrittenWorkbook } from './company-export-writer';

/** Own transaction/connection (the read tx is long); CAS on PROCESSING so a swept job is never resurrected. */
export async function companyExportHeartbeat(tenantPrisma: TenantPrismaService, companyId: string, exportJobId: string): Promise<void> {
  // Intentionally runs on a 2nd connection while the export's read tx is open (liveness must commit independently).
  await tenantPrisma.run(
    companyId,
    (tx) => tx.exportJob.updateMany({ where: { id: exportJobId, status: 'PROCESSING' }, data: { updatedAt: new Date() } }),
    undefined,
    { allowNested: true },
  );
}

/**
 * ADR-045: consumes `company-export` jobs. Same lifecycle as Export1cProcessor (atomic QUEUED->PROCESSING claim,
 * last-attempt FAILED / earlier attempts back to QUEUED, deterministic storage key). The read phase is ONE
 * REPEATABLE READ tenant transaction (consistent snapshot across sheets) that only streams pages into a temp
 * file; the upload happens after it commits, outside any DB transaction.
 */
@Processor(COMPANY_EXPORT_QUEUE)
export class CompanyExportProcessor extends WorkerHost {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly storage: StorageService,
  ) {
    super();
  }

  process(job: Job<CompanyExportJobData>): Promise<void> {
    return runJobWithTrace(job, () => this.handle(job));
  }

  private async handle(job: Job<CompanyExportJobData>): Promise<void> {
    const { exportJobId, companyId } = job.data;

    // Idempotency: only a QUEUED job is picked up; redelivery of any other state is a no-op.
    const claimed = await this.tenantPrisma.run(companyId, async (tx) => {
      const { count } = await tx.exportJob.updateMany({ where: { id: exportJobId, type: COMPANY_EXPORT_TYPE, status: 'QUEUED' }, data: { status: 'PROCESSING', attemptCount: { increment: 1 } } });
      return count === 1;
    });
    if (!claimed) return;

    let written: WrittenWorkbook | undefined;
    try {
      // Liveness: bumps updatedAt on another connection so the stale-PROCESSING sweep spares a long, healthy export.
      const heartbeat = () => companyExportHeartbeat(this.tenantPrisma, companyId, exportJobId);
      written = await this.tenantPrisma.run(companyId, (tx) => writeCompanyWorkbook(tx, heartbeat), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: COMPANY_EXPORT_READ_TIMEOUT_MS,
        maxWait: 30_000,
      });

      const storageKey = companyExportStorageKey(companyId, exportJobId);
      await this.storage.putObjectStream({ key: storageKey, body: createReadStream(written.filePath), contentLength: written.fileSize, mimeType: XLSX_MIME });

      const w = written;
      // Guarded: if the sweep already FAILED this job, write nothing.
      await this.tenantPrisma.run(companyId, (tx) =>
        tx.exportJob.updateMany({
          where: { id: exportJobId, status: 'PROCESSING' },
          data: {
            status: 'GENERATED',
            storageKey,
            fileName: `company-export-${new Date().toISOString().slice(0, 10)}.xlsx`,
            fileSize: w.fileSize,
            fileHash: w.fileHash,
            recordCount: w.recordCount,
            mappingVersion: COMPANY_EXPORT_MAPPING_VERSION,
            generatedAt: new Date(),
            errorLog: Prisma.DbNull,
          },
        }),
      );
    } catch (err) {
      const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
      await this.tenantPrisma.run(companyId, (tx) =>
        tx.exportJob.updateMany({
          where: { id: exportJobId, status: 'PROCESSING' },
          data: { status: isLastAttempt ? 'FAILED' : 'QUEUED', errorLog: { message: describeError(err) } },
        }),
      );
      throw err; // BullMQ retries (backoff) or records the failure
    } finally {
      await written?.dispose();
    }
  }
}
