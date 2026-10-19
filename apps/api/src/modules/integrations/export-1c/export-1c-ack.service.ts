import { Injectable } from '@nestjs/common';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { ExportJobNotFoundException } from '../integrations-exceptions';
import type { AckExportDto } from './dto/ack-export.dto';
import { ExportAckChecksumMismatchException, ExportLegacyNoChecksumException, ExportAckNoteRequiredException, ExportAckNotAllowedException } from './export-1c-exceptions';

/** ADR-030: one-shot manual ACK GENERATED -> ACCOUNTING_ACCEPTED | FAILED_REVIEW (DB trigger + CHECKs back this up). */
@Injectable()
export class Export1cAckService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async acknowledge(id: string, dto: AckExportDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const job = await tx.exportJob.findFirst({ where: { id, type: '1c' } }); // RLS: other tenant => null
    if (!job) throw new ExportJobNotFoundException();

    const note = dto.note?.trim() ?? '';
    if (dto.result === 'REJECTED' && note.length < 3) throw new ExportAckNoteRequiredException();
    if (job.status !== 'GENERATED') throw new ExportAckNotAllowedException(job.status);
    if (!job.fileHash) throw new ExportLegacyNoChecksumException();
    if (dto.checksum.toLowerCase() !== job.fileHash) throw new ExportAckChecksumMismatchException();

    const status = dto.result === 'ACCEPTED' ? 'ACCOUNTING_ACCEPTED' : 'FAILED_REVIEW';
    const now = new Date();
    // Compare-and-set: a concurrent second ACK updates 0 rows => 409.
    const { count } = await tx.exportJob.updateMany({
      where: { id, status: 'GENERATED' },
      data: { status, acknowledgedAt: now, acknowledgedBy: user.id, ackChecksum: job.fileHash, ackNote: note || null },
    });
    if (count !== 1) throw new ExportAckNotAllowedException('ACKNOWLEDGED');

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'export.ack',
      entity: 'ExportJob',
      entityId: id,
      newValue: toAuditJson({ result: dto.result, status, jobId: id, fileHash: job.fileHash }),
    });
    return tx.exportJob.findFirstOrThrow({ where: { id } });
  }
}
