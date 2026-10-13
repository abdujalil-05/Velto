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

  async listRuns(q: ListReconciliationRunsQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const [rows, total] = await Promise.all([
      tx.reconciliationRun.findMany({
        orderBy: { startedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      tx.reconciliationRun.count(),
    ]);
    // Stock counts are stock-level data: hide them from users without stock.read.
    const data: unknown[] = user.permissions.includes('stock.read')
      ? rows
      : rows.map((r) => ({ ...r, stockChecked: null, stockFindings: null }));
    return paginate(data, total, q.page, q.pageSize);
  }

  async listFindings(q: ListReconciliationFindingsQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // STOCK findings expose per-product/warehouse quantities: require stock.read.
    // Without it: omitted kind => BALANCE only; explicit kind=STOCK => empty page.
    const canSeeStock = user.permissions.includes('stock.read');
    if (!canSeeStock && q.kind === 'STOCK') return paginate([], 0, q.page, q.pageSize);
    const where: Prisma.ReconciliationFindingWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(canSeeStock ? (q.kind ? { kind: q.kind } : {}) : { kind: 'BALANCE' as const }),
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
