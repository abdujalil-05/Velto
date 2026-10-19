import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { lockCompanyExportExclusive } from '../../common/locks/company-export-lock';
import { paginate } from '../../common/pagination/pagination.dto';
import { addTracedJob } from '../../common/queue/trace-job';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { ExportJobNotFoundException } from '../integrations/integrations-exceptions';
import type { ListExportsQueryDto } from '../integrations/export-1c/dto/list-exports.query';
import { CompanyExportActiveException } from './company-export-exceptions';
import { COMPANY_EXPORT_JOB_OPTS, COMPANY_EXPORT_QUEUE, COMPANY_EXPORT_TYPE, MAX_ACTIVE_COMPANY_EXPORTS, type CompanyExportJobData } from './company-export.constants';

/** ADR-045: full tenant data export (DSR/offboarding, §11.7.2). Reuses ExportJob (type='company', format EXCEL; ACK statuses are never used). */
@Injectable()
export class CompanyExportService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @InjectQueue(COMPANY_EXPORT_QUEUE) private readonly queue: Queue<CompanyExportJobData>,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    await lockCompanyExportExclusive(); // parallel creates cannot exceed the active limit
    const active = await tx.exportJob.count({ where: { type: COMPANY_EXPORT_TYPE, status: { in: ['QUEUED', 'PROCESSING'] } } });
    if (active >= MAX_ACTIVE_COMPANY_EXPORTS) throw new CompanyExportActiveException();

    const now = new Date(); // ExportJob.period* are NOT NULL: for a full export they record the snapshot instant
    const job = await tx.exportJob.create({
      data: { companyId: user.companyId, type: COMPANY_EXPORT_TYPE, format: 'EXCEL', periodFrom: now, periodTo: now, status: 'QUEUED', requestedBy: user.id },
    });
    await this.auditLog.log(tx, { companyId: user.companyId, userId: user.id, action: 'company.export', entity: 'ExportJob', entityId: job.id, newValue: { jobId: job.id, format: 'EXCEL' } });
    TenantContext.afterCommit(() => addTracedJob(this.queue, 'export', { exportJobId: job.id, companyId: user.companyId }, { ...COMPANY_EXPORT_JOB_OPTS, jobId: `export-${job.id}` }));
    return job;
  }

  async list(query: ListExportsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where = { type: COMPANY_EXPORT_TYPE };
    const [data, total] = await Promise.all([
      tx.exportJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      tx.exportJob.count({ where }),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const job = await this.tenantPrisma.client.exportJob.findFirst({ where: { id, type: COMPANY_EXPORT_TYPE } });
    if (!job) throw new ExportJobNotFoundException();
    return job;
  }
}
