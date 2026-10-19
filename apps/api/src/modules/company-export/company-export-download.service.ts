import { Injectable } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { StorageService } from '../../common/storage/storage.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { ExportNotDownloadableException } from '../integrations/export-1c/export-1c-exceptions';
import type { ExportDownload } from '../integrations/export-1c/export-1c-download.service';
import { ExportJobNotFoundException } from '../integrations/integrations-exceptions';
import { COMPANY_EXPORT_TYPE, XLSX_MIME } from './company-export.constants';

/** Private file streaming through the API only (ADR-037 pattern): permission is re-checked by the controller, RLS scopes the job, no URL leaves the server. */
@Injectable()
export class CompanyExportDownloadService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
  ) {}

  async download(id: string, user: AuthenticatedUser): Promise<ExportDownload> {
    const tx = this.tenantPrisma.client;
    const job = await tx.exportJob.findFirst({ where: { id, type: COMPANY_EXPORT_TYPE } }); // RLS: other tenant => null
    if (!job) throw new ExportJobNotFoundException();
    if (job.status !== 'GENERATED' || !job.storageKey || !job.fileHash) throw new ExportNotDownloadableException(job.status);

    const { stream, size } = await this.storage.getObject(job.storageKey);
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'company.export.download',
      entity: 'ExportJob',
      entityId: id,
      newValue: { jobId: id, fileHash: job.fileHash },
    });
    const fileName = (job.fileName ?? `company-export-${job.id}.xlsx`).replace(/[^\w.-]/g, '_');
    return { stream, size: size ?? job.fileSize ?? undefined, mimeType: XLSX_MIME, fileName, fileHash: job.fileHash };
  }
}
