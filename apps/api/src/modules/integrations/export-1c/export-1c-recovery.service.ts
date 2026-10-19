import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, systemPrisma } from '@velto/database';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { EXPORT_1C_STALE_PROCESSING_MS, EXPORT_1C_SWEEP_INTERVAL_MS } from './export-1c.constants';

/**
 * Fails ExportJobs stuck in PROCESSING (worker crashed mid-job, Redis lost the
 * entry). Idempotent: the status guard in updateMany makes a re-run a no-op.
 */
@Injectable()
export class Export1cRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Export1cRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

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
    return failed;
  }
}
