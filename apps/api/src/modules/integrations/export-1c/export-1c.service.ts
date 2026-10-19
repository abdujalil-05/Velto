import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { ExportJobNotFoundException, InvalidExportPeriodException } from '../integrations-exceptions';
import type { CreateExportDto } from './dto/create-export.dto';
import type { ListExportsQueryDto } from './dto/list-exports.query';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import { addTracedJob } from '../../../common/queue/trace-job';
import { lockExport1cExclusive } from '../../../common/locks/export1c-lock';
import { companyDay } from '../../field/company-day';
import { EXPORT_1C_JOB_OPTS, EXPORT_1C_QUEUE, type Export1cJobData } from './export-1c.constants';

/** 11.1: "Buxgalter /export/1c'da davrni tanlaydi -> fayl BullMQ orqali fon rejimida generatsiya qilinadi -> yuklab olinadi." */
@Injectable()
export class Export1cService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @InjectQueue(EXPORT_1C_QUEUE) private readonly queue: Queue<Export1cJobData>,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(dto: CreateExportDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // TZ §7.1: day boundaries follow Company.timezone, never the server clock.
    const company = await tx.company.findFirst({ select: { timezone: true } });
    const tz = company?.timezone ?? 'Asia/Tashkent';
    const periodFrom = companyDay(new Date(dto.from), tz).start;
    const periodTo = new Date(companyDay(new Date(dto.to), tz).end.getTime() - 1);
    if (periodFrom > periodTo) throw new InvalidExportPeriodException();

    await lockExport1cExclusive(); // ADR-025: serialize with payments.reverse() (shared)
    const job = await tx.exportJob.create({
      data: {
        companyId: user.companyId,
        type: '1c',
        format: dto.format ?? 'EXCEL', // XML stays opt-in: CommerceML not yet validated on a pilot 1C configuration
        periodFrom,
        periodTo,
        status: 'QUEUED',
        requestedBy: user.id,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'export.create',
      entity: 'ExportJob',
      entityId: job.id,
      newValue: toAuditJson({ type: job.type, format: job.format, periodFrom, periodTo }),
    });

    // Deferred until this request's transaction actually commits — enqueuing
    // here immediately would let the worker dequeue and query for this
    // ExportJob row before the surrounding TenantPrismaService.run()
    // transaction (TenantContextInterceptor wraps the whole request) commits.
    TenantContext.afterCommit(() => addTracedJob(this.queue, 'export', { exportJobId: job.id, companyId: user.companyId }, { ...EXPORT_1C_JOB_OPTS, jobId: `export-${job.id}` }));
    return job;
  }

  async list(query: ListExportsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where = { type: '1c' };
    const [data, total] = await Promise.all([
      tx.exportJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.exportJob.count({ where }),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const job = await this.tenantPrisma.client.exportJob.findFirst({ where: { id, type: '1c' } });
    if (!job) throw new ExportJobNotFoundException();
    return job;
  }
}
