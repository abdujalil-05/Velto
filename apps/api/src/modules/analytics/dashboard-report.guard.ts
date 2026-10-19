import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { ReportConcurrencyGuard } from '../../common/concurrency/report-concurrency.guard';
import { ReportConcurrencyLimiter } from '../../common/concurrency/report-concurrency.limiter';
import { DashboardService } from './dashboard.service';

/** Dashboard: a cache hit (or join of an in-flight compute) takes no permit. */
@Injectable()
export class DashboardReportGuard extends ReportConcurrencyGuard {
  constructor(
    limiter: ReportConcurrencyLimiter,
    reflector: Reflector,
    tenantPrisma: TenantPrismaService,
    private readonly dashboard: DashboardService,
  ) {
    super(limiter, reflector, tenantPrisma);
  }

  protected override shouldSkip(req: Request): boolean {
    const companyId = (req as Request & { tokenPayload?: { companyId?: string } }).tokenPayload?.companyId;
    return !!companyId && this.dashboard.hasLiveEntry(companyId);
  }
}
