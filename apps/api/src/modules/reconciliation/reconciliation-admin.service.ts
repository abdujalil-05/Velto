import { Injectable } from '@nestjs/common';
import type { Prisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { paginate } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { ListReconciliationFindingsQueryDto } from './dto/list-findings.query';
import type { ListReconciliationRunsQueryDto } from './dto/list-runs.query';
import { ReconciliationAlertService } from './reconciliation-alert.service';
import { ReconciliationService } from './reconciliation.service';

/** Request-facing reads + manual run; detection/fix logic stays in ReconciliationService. */
@Injectable()
export class ReconciliationAdminService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly reconciliation: ReconciliationService,
    private readonly alerts: ReconciliationAlertService,
  ) {}

  async listRuns(q: ListReconciliationRunsQueryDto) {
    const tx = this.tenantPrisma.client;
    const [rows, total] = await Promise.all([
      tx.reconciliationRun.findMany({
        orderBy: { startedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      tx.reconciliationRun.count(),
    ]);
    return paginate(rows, total, q.page, q.pageSize);
  }

  async listFindings(q: ListReconciliationFindingsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.ReconciliationFindingWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    };
    const [rows, total] = await Promise.all([
      tx.reconciliationFinding.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      tx.reconciliationFinding.count({ where }),
    ]);
    return paginate(rows, total, q.page, q.pageSize);
  }

  /**
   * runDetection opens its OWN REPEATABLE READ tx on a separate pool
   * connection (TenantPrismaService.run -> withTenant), so it neither nests
   * in nor is weakened by the interceptor's READ COMMITTED request tx. The
   * request tx has only done permission SELECTs (no locks), so it cannot
   * deadlock with the run's advisory lock. Alert is a third, short tx.
   */
  async runManual(user: AuthenticatedUser) {
    const result = await this.reconciliation.runDetection(user.companyId, {
      trigger: 'MANUAL',
      triggeredById: user.id,
    });
    await this.alerts.alertIfDrift(user.companyId, result);
    return result;
  }
}
