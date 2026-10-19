import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma, systemPrisma } from '@velto/database';
import { addTracedJob } from '../../../common/queue/trace-job';
import { COMPANY_EXPORT_JOB_OPTS, COMPANY_EXPORT_QUEUE, COMPANY_EXPORT_TYPE, type CompanyExportJobData } from '../../company-export/company-export.constants';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import {
  EXPORT_1C_ABANDONED_QUEUED_MS,
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
    const stuck = await systemPrisma.exportJob.findMany({ where: { status: 'PROCESSING', updatedAt: { lt: cutoff } }, select: { id: true, companyId: true }, take: 100 });
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
    const abandonedCutoff = new Date(now.getTime() - EXPORT_1C_ABANDONED_QUEUED_MS);
    const where = { type, status: 'QUEUED' as const, updatedAt: { lt: cutoff } };
    const orphans: Array<{ id: string; companyId: string; updatedAt: Date }> = [];
    for (let cursor: string | undefined; ; ) {
      const batch = await systemPrisma.exportJob.findMany({ where, select: { id: true, companyId: true, updatedAt: true }, orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      orphans.push(...batch);
      if (batch.length < 100) break;
      cursor = batch[batch.length - 1]!.id;
    }
    let failed = 0;
    for (const j of orphans) {
      try {
        await addTracedJob(queue, 'export', { exportJobId: j.id, companyId: j.companyId }, { ...opts, jobId: `export-${j.id}` });
      } catch (e) {
        this.logger.error(`re-enqueue failed: ${e instanceof Error ? e.name : 'error'}`);
        if (j.updatedAt >= abandonedCutoff) continue;
        // QUEUED -> FAILED is not a legal trigger transition; go through PROCESSING.
        failed += await this.tenantPrisma.run(j.companyId, async (tx) => {
          const claimed = await tx.exportJob.updateMany({ where: { id: j.id, status: 'QUEUED', updatedAt: { lt: abandonedCutoff } }, data: { status: 'PROCESSING' } });
          if (claimed.count !== 1) return 0;
          const res = await tx.exportJob.updateMany({
            where: { id: j.id, status: 'PROCESSING' },
            data: { status: 'FAILED', errorLog: { message: "Eksport 1 soatdan ortiq QUEUED holatida qoldi (navbatga qo'yib bo'lmadi)" } as Prisma.InputJsonValue },
          });
          return res.count;
        });
      }
    }
    return failed;
  }
}
