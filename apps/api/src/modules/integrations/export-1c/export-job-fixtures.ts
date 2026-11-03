import { createHash, randomUUID } from 'node:crypto';
import type { ExportFormat } from '@velto/database';
import type { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';

/** Test-only: drives an ExportJob through the DB-enforced chain QUEUED -> PROCESSING -> GENERATED|FAILED (direct GENERATED/DONE inserts are rejected by trigger, ADR-030). */
export async function insertExportJob(
  tenantPrisma: TenantPrismaService,
  companyId: string,
  opts: { periodFrom: Date; periodTo: Date; status: 'GENERATED' | 'FAILED'; format?: ExportFormat },
) {
  return tenantPrisma.run(companyId, async (tx) => {
    const job = await tx.exportJob.create({
      data: { companyId, type: '1c', format: opts.format ?? 'XML', periodFrom: opts.periodFrom, periodTo: opts.periodTo },
    });
    await tx.exportJob.update({ where: { id: job.id }, data: { status: 'PROCESSING', attemptCount: 1 } });
    if (opts.status === 'FAILED') {
      return tx.exportJob.update({ where: { id: job.id }, data: { status: 'FAILED', errorLog: { message: 'fixture' } } });
    }
    return tx.exportJob.update({
      where: { id: job.id },
      data: {
        status: 'GENERATED',
        storageKey: `exports/1c/${companyId}/${job.id}.xml`,
        fileName: 'fixture.xml',
        fileSize: 1,
        fileHash: createHash('sha256').update(randomUUID()).digest('hex'),
        recordCount: 1,
        mappingVersion: 1,
        generatedAt: new Date(),
      },
    });
  });
}
