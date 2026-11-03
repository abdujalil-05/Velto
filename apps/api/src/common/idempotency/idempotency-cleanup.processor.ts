import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { systemPrisma } from '@velto/database';
import { runJobWithTrace } from '../queue/trace-job';
import { IDEMPOTENCY_CLEANUP_QUEUE, type IdempotencyCleanupJobData } from './idempotency.constants';

/** Deletes expired idempotency records across all tenants (systemPrisma, BYPASSRLS). */
@Processor(IDEMPOTENCY_CLEANUP_QUEUE)
export class IdempotencyCleanupProcessor extends WorkerHost {
  process(job: Job<IdempotencyCleanupJobData>): Promise<number> {
    return runJobWithTrace(job, () => this.purgeExpired());
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await systemPrisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
    return count;
  }
}
