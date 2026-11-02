import { Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { auditRejection } from '../../../common/audit/rejection-audit';
import { getTraceId } from '../../../common/trace/trace-context';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { StorageService } from '../../../common/storage/storage.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CSV_MIME, XLSX_MIME } from '../../analytics/report-export';
import { ExportJobNotFoundException } from '../integrations-exceptions';
import { ExportLegacyNoChecksumException, ExportNotDownloadableException } from './export-1c-exceptions';

const DOWNLOADABLE = ['GENERATED', 'ACCOUNTING_ACCEPTED', 'FAILED_REVIEW'];
const MIME = { EXCEL: XLSX_MIME, CSV: CSV_MIME, XML: 'application/xml; charset=utf-8' } as const;

export interface ExportDownload {
  stream: Readable;
  size?: number;
  mimeType: string;
  fileName: string;
  fileHash: string;
}

/** Private file streaming through the API (no public URL ever leaves the server — SEC-001/009). */
@Injectable()
export class Export1cDownloadService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
  ) {}

  async download(id: string, user: AuthenticatedUser): Promise<ExportDownload> {
    const tx = this.tenantPrisma.client;
    const job = await tx.exportJob.findFirst({ where: { id, type: '1c' } }); // RLS: other tenant => null
    if (!job) {
      // Foreign and missing ids are indistinguishable (same 404); the denial row survives the request-tx rollback.
      throw auditRejection(
        this.tenantPrisma,
        this.auditLog,
        { companyId: user.companyId, userId: user.id, action: 'export.download', entity: 'ExportJob', entityId: id },
        new ExportJobNotFoundException(),
        { jobId: id, traceId: getTraceId() ?? 'n/a' },
      );
    }
    if (!DOWNLOADABLE.includes(job.status) || !job.storageKey) throw new ExportNotDownloadableException(job.status);
    if (!job.fileHash) throw new ExportLegacyNoChecksumException();

    const { stream, size } = await this.storage.getObject(job.storageKey);
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'export.download',
      entity: 'ExportJob',
      entityId: id,
      newValue: toAuditJson({ jobId: id, format: job.format, fileHash: job.fileHash }),
    });
    // fileName is server-generated, but never trust it blindly inside a header.
    const fileName = (job.fileName ?? `export-${job.id}`).replace(/[^\w.-]/g, '_');
    return { stream, size: size ?? job.fileSize ?? undefined, mimeType: MIME[job.format], fileName, fileHash: job.fileHash };
  }
}
