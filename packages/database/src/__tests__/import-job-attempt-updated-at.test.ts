// ADR-064b: ImportJob.attemptCount / ImportJob.updatedAt
// (migration 20261031120000_import_job_attempt_count_updated_at).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPrisma, withTenant } from '../client';

const PAST = new Date('2000-01-01T00:00:00.000Z');

describe('ImportJob attemptCount + updatedAt (ADR-064b)', () => {
  let companyAId: string;
  let companyBId: string;
  const jobIds: string[] = [];

  async function rawInsert(companyId: string): Promise<string> {
    // Mirrors a writer that predates the columns: neither is mentioned.
    const id = await withTenant(companyId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "ImportJob" ("id", "companyId", "type", "status", "fileUrl")
        VALUES (gen_random_uuid(), ${companyId}::uuid, 'customers', 'PENDING', 's3://t/x.xlsx')
        RETURNING "id"`;
      return rows[0]!.id;
    });
    jobIds.push(id);
    return id;
  }

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-importjob-064b-${Date.now()}`, name: 'ImportJob 064b Test' },
    });
    const [a, b] = await Promise.all([
      systemPrisma.company.create({ data: { tenantId: tenant.id, name: '064b Co A' } }),
      systemPrisma.company.create({ data: { tenantId: tenant.id, name: '064b Co B' } }),
    ]);
    companyAId = a.id;
    companyBId = b.id;
  });

  afterAll(async () => {
    await systemPrisma.importJob.deleteMany({ where: { id: { in: jobIds } } });
    await systemPrisma.$disconnect();
  });

  it('applies defaults to rows written without the new columns', async () => {
    const id = await rawInsert(companyAId);
    const job = await withTenant(companyAId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id } }));
    expect(job.attemptCount).toBe(0);
    expect(job.updatedAt).toBeInstanceOf(Date);
    expect(job.updatedAt.getTime()).toBeGreaterThanOrEqual(job.createdAt.getTime() - 1000);
  });

  it('every historical row has a non-null updatedAt not earlier than createdAt', async () => {
    const [{ bad }] = await systemPrisma.$queryRaw<[{ bad: bigint }]>`
      SELECT count(*)::bigint AS bad FROM "ImportJob" WHERE "updatedAt" IS NULL OR "updatedAt" < "createdAt"`;
    expect(Number(bad)).toBe(0);
  });

  it('BEFORE UPDATE trigger bumps updatedAt on a raw-SQL UPDATE that does not mention it', async () => {
    const id = await withTenant(companyAId, async (tx) => {
      const j = await tx.importJob.create({
        data: { companyId: companyAId, type: 'customers', status: 'PROCESSING', fileUrl: 's3://t/y.xlsx', updatedAt: PAST },
      });
      return j.id;
    });
    jobIds.push(id);
    // INSERT is not touched by the trigger: the explicit value survives.
    const before = await withTenant(companyAId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id } }));
    expect(before.updatedAt.toISOString()).toBe(PAST.toISOString());

    const startedAt = Date.now();
    const n = await withTenant(companyAId, (tx) =>
      tx.$executeRaw`UPDATE "ImportJob" SET "progress" = 42 WHERE "id" = ${id}::uuid`,
    );
    expect(n).toBe(1);
    const after = await withTenant(companyAId, (tx) => tx.importJob.findUniqueOrThrow({ where: { id } }));
    expect(after.progress).toBe(42);
    expect(after.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    // UTC-pinned: within a minute of the client clock, not shifted by a TZ offset.
    expect(Math.abs(after.updatedAt.getTime() - startedAt)).toBeLessThan(60_000);
  });

  it('trigger overrides an explicit stale updatedAt on UPDATE (BYPASSRLS writer too)', async () => {
    const id = await rawInsert(companyAId);
    await systemPrisma.$executeRaw`UPDATE "ImportJob" SET "updatedAt" = ${PAST}, "attemptCount" = "attemptCount" + 1 WHERE "id" = ${id}::uuid`;
    const job = await systemPrisma.importJob.findUniqueOrThrow({ where: { id } });
    expect(job.attemptCount).toBe(1);
    expect(job.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
  });

  it('CHECK rejects a negative attemptCount (Prisma and raw SQL)', async () => {
    const id = await rawInsert(companyAId);
    await expect(
      withTenant(companyAId, (tx) => tx.importJob.update({ where: { id }, data: { attemptCount: -1 } })),
    ).rejects.toThrow(/ImportJob_attemptCount_nonneg_check/);
    await expect(
      withTenant(companyAId, (tx) => tx.$executeRaw`UPDATE "ImportJob" SET "attemptCount" = -1 WHERE "id" = ${id}::uuid`),
    ).rejects.toThrow(/ImportJob_attemptCount_nonneg_check/);
    await expect(
      withTenant(companyAId, (tx) =>
        tx.importJob.create({
          data: { companyId: companyAId, type: 'customers', status: 'PENDING', fileUrl: 's3://t/z.xlsx', attemptCount: -5 },
        }),
      ),
    ).rejects.toThrow(/ImportJob_attemptCount_nonneg_check/);
  });

  it('RLS still isolates the row: another tenant cannot see or bump it', async () => {
    const id = await rawInsert(companyAId);
    const seen = await withTenant(companyBId, (tx) => tx.importJob.findMany({ where: { id } }));
    expect(seen).toHaveLength(0);
    const n = await withTenant(companyBId, (tx) =>
      tx.$executeRaw`UPDATE "ImportJob" SET "attemptCount" = "attemptCount" + 1 WHERE "id" = ${id}::uuid`,
    );
    expect(n).toBe(0);
    const job = await systemPrisma.importJob.findUniqueOrThrow({ where: { id } });
    expect(job.attemptCount).toBe(0);
  });
});
