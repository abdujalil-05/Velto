import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { systemPrisma } from '@velto/database';
import { runJobWithTrace } from '../../common/queue/trace-job';
import { RECONCILIATION_QUEUE, type ReconciliationJobData } from './reconciliation.constants';
import { ReconciliationBusyException } from './reconciliation-exceptions';
import { ReconciliationAlertService } from './reconciliation-alert.service';
import { ReconciliationService } from './reconciliation.service';

export interface ReconciliationSweepResult {
  ok: number;
  failed: number;
  busy: number;
}

/** Daily 03:00 Asia/Tashkent sweep. systemPrisma only lists companies; each run is tenant-scoped and isolated. */
@Processor(RECONCILIATION_QUEUE)
export class ReconciliationScheduleProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationScheduleProcessor.name);

  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly alerts: ReconciliationAlertService,
  ) {
    super();
  }

  process(job: Job<ReconciliationJobData>): Promise<ReconciliationSweepResult> {
    return runJobWithTrace(job, () => this.runAll());
  }

  async runAll(): Promise<ReconciliationSweepResult> {
    const companies = await systemPrisma.company.findMany({ select: { id: true } });
    const out: ReconciliationSweepResult = { ok: 0, failed: 0, busy: 0 };
    for (const { id } of companies) {
      try {
        const result = await this.reconciliation.runDetection(id, { trigger: 'SCHEDULED' });
        out.ok++;
        try {
          await this.alerts.alertIfDrift(id, result);
        } catch (e) {
          this.logger.error(`reconciliation alert failed company=${id}: ${(e as Error).message}`);
        }
      } catch (e) {
        if (e instanceof ReconciliationBusyException) out.busy++;
        else out.failed++;
        this.logger.error(`reconciliation run failed company=${id}: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
