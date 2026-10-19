import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { ExportActiveLimitException } from './export-1c-exceptions';

export const MAX_ACTIVE_1C_EXPORTS = 3;

@Injectable()
export class Export1cLimitsService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /** At most MAX_ACTIVE_1C_EXPORTS QUEUED/PROCESSING 1C jobs per company (RLS-scoped count). */
  async assertCanCreate(): Promise<void> {
    const active = await this.tenantPrisma.client.exportJob.count({ where: { type: '1c', status: { in: ['QUEUED', 'PROCESSING'] } } });
    if (active >= MAX_ACTIVE_1C_EXPORTS) throw new ExportActiveLimitException(MAX_ACTIVE_1C_EXPORTS);
  }
}
