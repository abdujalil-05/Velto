import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma, systemPrisma } from '@velto/database';
import { fetchAllById } from '../../common/pagination/fetch-all-by-id';
import { addTracedJobReplacingTerminal } from '../../common/queue/trace-job';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { IMPORT_COMMIT_FAILED } from './import-exceptions';
import { IMPORT_JOB_OPTS, IMPORT_QUEUE, type ImportJobData } from './import.constants';

const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Recovers ImportJobs stuck in PROCESSING (e.g. Redis was down at enqueue
 * time or the queue entry was lost). Idempotent: re-enqueue uses the fixed
 * jobId `import-<id>` (duplicate add is a BullMQ no-op) and the processor
 * resumes from its persisted chunk cursor.
 */
@Injectable()
export class ImportRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue<ImportJobData>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep().catch((e) => this.logger.error(`sweep failed: ${e instanceof Error ? e.name : 'error'}`)), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns the number of jobs re-enqueued or failed. */
  async sweep(): Promise<number> {
    const stuck = await fetchAllById((page) => systemPrisma.importJob.findMany({ where: { status: 'PROCESSING' }, select: { id: true, companyId: true, createdBy: true }, orderBy: { id: 'asc' }, ...page }));
    let touched = 0;
    for (const j of stuck) {
      try {
        const queued = await this.queue.getJob(`import-${j.id}`);
        const state = queued ? await queued.getState() : 'missing';
        // 'completed' with a PROCESSING row = orphan (late no-op run / zombie): replace the dedup-blocking entry.
        if (state === 'missing' || state === 'completed') {
          await addTracedJobReplacingTerminal(this.queue, 'commit', { importJobId: j.id, companyId: j.companyId, userId: j.createdBy ?? undefined }, { ...IMPORT_JOB_OPTS, jobId: `import-${j.id}` });
          touched++;
        } else if (state === 'failed') {
          await this.tenantPrisma.run(j.companyId, (tx) =>
            tx.importJob.updateMany({ where: { id: j.id, status: 'PROCESSING' }, data: { status: 'FAILED', errorLog: { ...IMPORT_COMMIT_FAILED } as unknown as Prisma.InputJsonValue } }),
          );
          touched++;
        }
      } catch (e) {
        this.logger.warn(`sweep skipped job ${j.id} (company ${j.companyId}): ${e instanceof Error ? e.name : 'error'}`);
      }
    }
    return touched;
  }
}
