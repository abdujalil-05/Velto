// ADR-064b operator-controlled recovery for an ImportJob that the sweep failed with IMPORT_RECOVERY_EXHAUSTED.
// systemPrisma only locates the job; the CAS + audit run in withTenant(companyId).
// FAILED(IMPORT_RECOVERY_EXHAUSTED) -> PROCESSING; errorLog.rows + commit cursor preserved; attemptCount is NOT reset
// (if the job is lost again the sweep fails it immediately). Any other FAILED code / DONE / other status is refused.
// Run: pnpm --filter @velto/api exec tsx src/scripts/retry-import-job.ts --company <id> --job <id> --reason "<text>" --operator "<owner user id|phone>" [--dry-run]
import { userInfo, hostname } from 'node:os';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, systemPrisma, withTenant } from '@velto/database';
import { getTraceId, newTraceId, runWithTraceId } from '../common/trace/trace-context';
import { addTracedJobReplacingTerminal } from '../common/queue/trace-job';
import { IMPORT_JOB_OPTS, IMPORT_QUEUE, type ImportJobData } from '../modules/import/import.constants';

export const IMPORT_MANUAL_RETRY_AUDIT_ACTION = 'import.recovery_manual_retry';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'Usage: retry-import-job.ts --company <uuid> --job <uuid> --reason "<text>" --operator "<owner user id|phone>" [--dry-run]';

export type RetryImportJobArgs = { companyId: string; jobId: string; reason: string; operator: string; dryRun: boolean };

export function parseRetryImportJobArgs(argv: readonly string[]): RetryImportJobArgs {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? (argv[i + 1] ?? '').trim() : '';
  };
  const companyId = get('--company');
  const jobId = get('--job');
  const reason = get('--reason');
  const operator = get('--operator');
  if (!companyId || !jobId || !reason || !operator) throw new Error(`Refusing to run: --company, --job, --reason and --operator are required. ${USAGE}`);
  if (!UUID_RE.test(companyId) || !UUID_RE.test(jobId)) throw new Error(`Refusing to run: --company and --job must be UUIDs. ${USAGE}`);
  return { companyId, jobId, reason, operator, dryRun: argv.includes('--dry-run') };
}

/**
 * --operator must be the id (UUID) or phone of an ACTIVE user of --company holding the OWNER role. This ties the audit actor to a
 * real account, but it is operator-ASSERTED: the CLI has no credential check (DB creds = trusted platform access).
 */
async function resolveOperator(companyId: string, operator: string): Promise<{ id: string; label: string }> {
  const byId = UUID_RE.test(operator);
  const user = await systemPrisma.user.findFirst({
    where: { companyId, isActive: true, ...(byId ? { id: operator } : { phone: operator }), roles: { some: { role: { companyId, code: 'OWNER' } } } },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!user) throw new Error(`Refusing: --operator must be an active OWNER user (id or phone) of company ${companyId}`);
  return { id: user.id, label: `${user.firstName} ${user.lastName}`.trim() };
}

export function retryImportJob(args: RetryImportJobArgs, queue?: Queue<ImportJobData>): Promise<{ jobId: string; dryRun: boolean; attemptCount: number }> {
  return runWithTraceId(getTraceId() ?? newTraceId(), () => doRetry(args, queue));
}

async function doRetry(args: RetryImportJobArgs, queue?: Queue<ImportJobData>): Promise<{ jobId: string; dryRun: boolean; attemptCount: number }> {
  const { companyId, jobId, reason, dryRun } = args;
  if (!reason.trim()) throw new Error('Refusing: --reason is required');
  const found = await systemPrisma.importJob.findFirst({ where: { id: jobId, companyId }, select: { id: true, status: true, errorLog: true, attemptCount: true, createdBy: true } });
  if (!found) throw new Error(`ImportJob ${jobId} not found in company ${companyId}`);
  const code = (found.errorLog as { code?: string } | null)?.code;
  if (found.status !== 'FAILED' || code !== 'IMPORT_RECOVERY_EXHAUSTED') throw new Error(`Refusing: job is ${found.status}${code ? `/${code}` : ''}; only FAILED/IMPORT_RECOVERY_EXHAUSTED can be retried`);
  const op = await resolveOperator(companyId, args.operator);
  if (dryRun) return { jobId, dryRun, attemptCount: found.attemptCount };
  if (!queue) throw new Error('queue required');

  const attemptCount = await withTenant(companyId, async (tx) => {
    const rows = await tx.$queryRaw<{ attemptCount: number }[]>`UPDATE "ImportJob" SET "status" = 'PROCESSING', "errorLog" = "errorLog" - 'code' - 'message' - 'maxAttempts' WHERE "id" = ${jobId}::uuid AND "status" = 'FAILED' AND "errorLog"->>'code' = 'IMPORT_RECOVERY_EXHAUSTED' RETURNING "attemptCount"`;
    if (rows.length !== 1) throw new Error('Refusing: job state changed concurrently');
    await tx.auditLog.create({
      data: {
        companyId,
        userId: op.id,
        traceId: getTraceId() ?? null,
        action: IMPORT_MANUAL_RETRY_AUDIT_ACTION,
        entity: 'ImportJob',
        entityId: jobId,
        oldValue: { status: 'FAILED', code } as Prisma.InputJsonValue,
        newValue: { actor: 'operator-asserted', operatorUserId: op.id, osUser: userInfo().username, host: hostname(), reason, status: 'PROCESSING', attemptCount: rows[0].attemptCount } as Prisma.InputJsonValue,
      },
    });
    return rows[0].attemptCount;
  });
  // After commit. If this enqueue fails the row stays PROCESSING and the sweep recovers it (attempts already exhausted -> fails again).
  await addTracedJobReplacingTerminal(queue, 'commit', { importJobId: jobId, companyId, userId: found.createdBy ?? undefined }, { ...IMPORT_JOB_OPTS, jobId: `import-${jobId}` });
  return { jobId, dryRun, attemptCount };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_IMPORT_RETRY !== '1') {
    throw new Error('Refusing to run: NODE_ENV=production. Re-run with ALLOW_PRODUCTION_IMPORT_RETRY=1 once reviewed.');
  }
  const args = parseRetryImportJobArgs(process.argv.slice(2));
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', { maxRetriesPerRequest: null });
  const queue = new Queue<ImportJobData>(IMPORT_QUEUE, { connection, prefix: process.env.BULLMQ_PREFIX ?? 'bull' }); // must match the app's queue prefix (queue.module.ts)
  try {
    console.log(JSON.stringify(await retryImportJob(args, queue)));
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => systemPrisma.$disconnect());
}
