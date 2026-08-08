import { Injectable } from '@nestjs/common';
import { paginate } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { ListAuditLogQueryDto } from './dto/list-audit-log.query';

const AUDIT_LOG_INCLUDE = { user: { select: { id: true, firstName: true, lastName: true } } } as const;

@Injectable()
export class AuditService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(query: ListAuditLogQueryDto) {
    const tx = this.tenantPrisma.client;

    const [data, total] = await Promise.all([
      tx.auditLog.findMany({
        include: AUDIT_LOG_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.auditLog.count(),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }
}
