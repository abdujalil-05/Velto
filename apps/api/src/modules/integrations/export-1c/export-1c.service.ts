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
import { EXPORT_1C_QUEUE, type Export1cJobData } from './export-1c.constants';

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** 11.1: "Buxgalter /export/1c'da davrni tanlaydi -> fayl BullMQ orqali fon rejimida generatsiya qilinadi -> yuklab olinadi." */
@Injectable()
export class Export1cService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @InjectQueue(EXPORT_1C_QUEUE) private readonly queue: Queue<Export1cJobData>,
  ) {}

  async create(dto: CreateExportDto, user: AuthenticatedUser) {
    const periodFrom = startOfDay(new Date(dto.from));
    const periodTo = endOfDay(new Date(dto.to));
    if (periodFrom > periodTo) throw new InvalidExportPeriodException();

    const tx = this.tenantPrisma.client;
    const job = await tx.exportJob.create({
      data: {
        companyId: user.companyId,
        type: '1c',
        format: dto.format ?? 'XML',
        periodFrom,
        periodTo,
        status: 'PENDING',
        requestedBy: user.id,
      },
    });

    // Deferred until this request's transaction actually commits — enqueuing
    // here immediately would let the worker dequeue and query for this
    // ExportJob row before the surrounding TenantPrismaService.run()
    // transaction (TenantContextInterceptor wraps the whole request) commits.
    TenantContext.afterCommit(() => this.queue.add('export', { exportJobId: job.id, companyId: user.companyId }));
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
