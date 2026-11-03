import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma, systemPrisma } from '@velto/database';
import { fetchAllById } from '../../common/pagination/fetch-all-by-id';
import { addTracedJobReplacingTerminal } from '../../common/queue/trace-job';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { IMPORT_COMMIT_FAILED, IMPORT_RECOVERY_EXHAUSTED } from './import-exceptions';
import { IMPORT_JOB_OPTS, IMPORT_QUEUE, IMPORT_RECOVERY_BACKOFF_BASE_S, IMPORT_RECOVERY_BACKOFF_CAP_S, importRecoveryMaxAttempts, type ImportJobData } from './import.constants';

const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Recovers ImportJobs stuck in PROCESSING (e.g. Redis was down at enqueue
 * time or the queue entry was lost). Idempotent: re-enqueue uses the fixed
 * jobId `import-<id>` (duplicate add is a BullMQ no-op) and the processor
 * resumes from its persisted chunk cursor. ADR-064b: bounded by ImportJob.attemptCount (env IMPORT_RECOVERY_MAX_ATTEMPTS).
 */
@Injectable()
export class ImportRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private readonly audit = new AuditLogService();

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

  /**
   * Returns the number of jobs re-enqueued or failed. `now` is injectable (updatedAt is trigger-stamped so tests cannot backdate rows).
   * Order per job: (1) real BullMQ state (Redis down -> getJob throws -> skipped, no attempt burned); active/waiting/delayed -> untouched
   * (a long-running import with an old updatedAt is not stuck); (2) only missing/completed (terminal orphan) -> DB CAS attemptCount+1
   * (single winner among parallel sweeps, honours backoff) BEFORE enqueue; (3) exhausted -> FAILED CAS + audit, imported rows kept.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const max = importRecoveryMaxAttempts();
    const stuck = await this.findStuck();
    let touched = 0;
    for (const j of stuck) {
      try {
        const queued = await this.queue.getJob(`import-${j.id}`);
        const state = queued ? await queued.getState() : 'missing';
        if (state === 'failed') {
          await this.tenantPrisma.run(j.companyId, (tx) =>
            tx.importJob.updateMany({ where: { id: j.id, status: 'PROCESSING' }, data: { status: 'FAILED', errorLog: { ...IMPORT_COMMIT_FAILED } as unknown as Prisma.InputJsonValue } }),
          );
          touched++;
        } else if (state === 'missing' || state === 'completed') {
          // 'completed' with a PROCESSING row = orphan (late no-op run / zombie): replace the dedup-blocking entry.
          const claimed = await this.claimAttempt(j.id, j.companyId, max, now);
          if (claimed === 'exhausted') {
            touched++;
            continue;
          }
          if (claimed !== 'claimed') continue;
          try {
            await addTracedJobReplacingTerminal(this.queue, 'commit', { importJobId: j.id, companyId: j.companyId, userId: j.createdBy ?? undefined }, { ...IMPORT_JOB_OPTS, jobId: `import-${j.id}` });
            touched++;
          } catch (e) {
            await this.releaseAttempt(j.id, j.companyId); // enqueue did not happen (Redis blip): do not burn the attempt
            throw e;
          }
        }
      } catch (e) {
        this.logger.warn(`sweep skipped job ${j.id} (company ${j.companyId}): ${e instanceof Error ? e.name : 'error'}`);
      }
    }
    return touched;
  }

  /** Candidate lookup (cross-tenant, systemPrisma). Protected so tests can scope it to their own company. */
  protected findStuck(): Promise<{ id: string; companyId: string; createdBy: string | null }[]> {
    return fetchAllById((page) => systemPrisma.importJob.findMany({ where: { status: 'PROCESSING' }, select: { id: true, companyId: true, createdBy: true }, orderBy: { id: 'asc' }, ...page }));
  }

  private static readonly BACKOFF = Prisma.sql`make_interval(secs => LEAST(${IMPORT_RECOVERY_BACKOFF_CAP_S}::float8, ${IMPORT_RECOVERY_BACKOFF_BASE_S}::float8 * POWER(2, "attemptCount")))`;

  /** Atomic CAS in one tenant tx: claim attempt n+1, or FAIL the job when exhausted. Parallel sweeps: only one UPDATE matches. */
  private claimAttempt(id: string, companyId: string, max: number, now: Date): Promise<'claimed' | 'exhausted' | 'skip'> {
    const due = Prisma.sql`"updatedAt" < (${now}::timestamptz AT TIME ZONE 'UTC') - ${ImportRecoveryService.BACKOFF}`;
    return this.tenantPrisma.run(companyId, async (tx) => {
      const won = await tx.$queryRaw<{ attemptCount: number }[]>`UPDATE "ImportJob" SET "attemptCount" = "attemptCount" + 1 WHERE "id" = ${id}::uuid AND "status" = 'PROCESSING' AND "attemptCount" < ${max} AND ${due} RETURNING "attemptCount"`;
      if (won.length === 1) return 'claimed' as const;
      // Exhausted: keep errorLog.rows (parsed payload the processor resumes from) + commit cursor/progress so operator retry (scripts/retry-import-job.ts) can resume; imported entities stay.
      const patch = JSON.stringify({ ...IMPORT_RECOVERY_EXHAUSTED, maxAttempts: max });
      const failed = await tx.$queryRaw<{ attemptCount: number }[]>`UPDATE "ImportJob" SET "status" = 'FAILED', "errorLog" = COALESCE("errorLog", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${id}::uuid AND "status" = 'PROCESSING' AND "attemptCount" >= ${max} AND ${due} RETURNING "attemptCount"`;
      if (failed.length !== 1) return 'skip' as const;
      await this.audit.log(tx, { companyId, action: 'import.failed_recovery_exhausted', entity: 'ImportJob', entityId: id, oldValue: { status: 'PROCESSING', attemptCount: failed[0].attemptCount }, newValue: { status: 'FAILED', reason: 'recovery_exhausted', maxAttempts: max } });
      return 'exhausted' as const;
    });
  }

  private async releaseAttempt(id: string, companyId: string): Promise<void> {
    await this.tenantPrisma
      .run(companyId, (tx) => tx.$executeRaw`UPDATE "ImportJob" SET "attemptCount" = GREATEST("attemptCount" - 1, 0) WHERE "id" = ${id}::uuid AND "status" = 'PROCESSING'`)
      .catch(() => undefined);
  }
}
