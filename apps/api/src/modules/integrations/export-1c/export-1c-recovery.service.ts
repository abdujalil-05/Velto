import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { fetchAllById } from '../../../common/pagination/fetch-all-by-id';
import { addTracedJobReplacingTerminal } from '../../../common/queue/trace-job';
import { COMPANY_EXPORT_JOB_OPTS, COMPANY_EXPORT_QUEUE, COMPANY_EXPORT_TYPE, type CompanyExportJobData } from '../../company-export/company-export.constants';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import {
  export1cAbandonedQueuedMs,
  EXPORT_1C_JOB_OPTS,
  EXPORT_1C_QUEUE,
  EXPORT_1C_STALE_PROCESSING_MS,
  EXPORT_1C_STALE_QUEUED_MS,
  EXPORT_1C_SWEEP_INTERVAL_MS,
  type Export1cJobData,
} from './export-1c.constants';

/**
 * Fails ExportJobs stuck in PROCESSING (worker crashed mid-job, Redis lost the
 * entry). Idempotent: the status guard in updateMany makes a re-run a no-op.
 */
@Injectable()
export class Export1cRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Export1cRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private readonly audit = new AuditLogService();

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @InjectQueue(EXPORT_1C_QUEUE) private readonly queue: Queue<Export1cJobData>,
    // ADR-045: company exports share this sweep (same stale/abandoned thresholds, same job-id scheme).
    @Optional() @InjectQueue(COMPANY_EXPORT_QUEUE) private readonly companyQueue?: Queue<CompanyExportJobData>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep().catch((e) => this.logger.error(`sweep failed: ${e instanceof Error ? e.name : 'error'}`)), EXPORT_1C_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns the number of jobs failed. */
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - EXPORT_1C_STALE_PROCESSING_MS);
    const stuck = await fetchAllById((page) => systemPrisma.exportJob.findMany({ where: { status: 'PROCESSING', updatedAt: { lt: cutoff } }, select: { id: true, companyId: true }, orderBy: { id: 'asc' }, ...page }));
    let failed = 0;
    for (const j of stuck) {
      const res = await this.tenantPrisma.run(j.companyId, (tx) =>
        tx.exportJob.updateMany({
          where: { id: j.id, status: 'PROCESSING', updatedAt: { lt: cutoff } },
          data: { status: 'FAILED', errorLog: { message: 'Eksport 15 daqiqadan ortiq PROCESSING holatida qoldi (worker to\'xtagan)' } as Prisma.InputJsonValue },
        }),
      );
      failed += res.count;
    }
    failed += await this.recoverOrphanedQueued(now, '1c', this.queue, EXPORT_1C_JOB_OPTS);
    if (this.companyQueue) failed += await this.recoverOrphanedQueued(now, COMPANY_EXPORT_TYPE, this.companyQueue, COMPANY_EXPORT_JOB_OPTS);
    return failed;
  }

  /**
   * QUEUED rows whose enqueue was lost (afterCommit failure / Redis data loss) would hold the active-job limit forever.
   * Re-enqueue with the same jobId (idempotent); if that also fails and the row is very old, fail it. Returns jobs failed.
   */
  private async recoverOrphanedQueued(now: Date, type: string, queue: Queue<Export1cJobData | CompanyExportJobData>, opts: typeof EXPORT_1C_JOB_OPTS): Promise<number> {
    const cutoff = new Date(now.getTime() - EXPORT_1C_STALE_QUEUED_MS);
    const abandonedCutoff = new Date(now.getTime() - export1cAbandonedQueuedMs());
    const where = { type, status: 'QUEUED' as const, updatedAt: { lt: cutoff } };
    const orphans = await fetchAllById((page) => systemPrisma.exportJob.findMany({ where, select: { id: true, companyId: true, updatedAt: true }, orderBy: { id: 'asc' }, ...page }));
    let failed = 0;
    for (const j of orphans) {
      // Past the abandoned cutoff fail the row regardless of enqueue outcome (a failed BullMQ entry would otherwise hold the active limit forever).
      if (j.updatedAt < abandonedCutoff) {
        failed += await this.failAbandoned(j.id, j.companyId, abandonedCutoff);
        continue;
      }
      try {
        await addTracedJobReplacingTerminal(queue, 'export', { exportJobId: j.id, companyId: j.companyId }, { ...opts, jobId: `export-${j.id}` });
      } catch (e) {
        // Per-job failure: log and continue; the next sweep retries.
        this.logger.warn(`re-enqueue failed for export ${j.id} (company ${j.companyId}): ${e instanceof Error ? e.name : 'error'}`);
      }
    }
    return failed;
  }

  private failAbandoned(id: string, companyId: string, abandonedCutoff: Date): Promise<number> {
    // QUEUED -> FAILED is not a legal trigger transition; go through PROCESSING.
    return this.tenantPrisma.run(companyId, async (tx) => {
      const claimed = await tx.exportJob.updateMany({ where: { id, status: 'QUEUED', updatedAt: { lt: abandonedCutoff } }, data: { status: 'PROCESSING' } });
      if (claimed.count !== 1) return 0;
      const res = await tx.exportJob.updateMany({
        where: { id, status: 'PROCESSING' },
        data: { status: 'FAILED', errorLog: { message: "Eksport uzoq vaqt QUEUED holatida qoldi (navbatga qo'yib bo'lmadi)" } as Prisma.InputJsonValue },
      });
      if (res.count === 1) {
        await this.audit.log(tx, { companyId, action: 'export.failed_abandoned', entity: 'ExportJob', entityId: id, oldValue: { status: 'QUEUED' }, newValue: { status: 'FAILED', reason: 'abandoned_queued' } });
      }
      return res.count;
    });
  }
}
