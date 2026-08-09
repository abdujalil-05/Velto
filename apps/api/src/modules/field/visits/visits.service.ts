import { Injectable } from '@nestjs/common';
import { Prisma, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { endOfDay, startOfDay } from '../../analytics/report-utils';
import { OutletNotFoundException } from '../../customers/customers-exceptions';
import { AgentNotFoundException, GpsTooFarException, VisitNotFoundException } from '../field-exceptions';
import { distanceMeters, VISIT_GPS_RADIUS_M } from '../geo';
import type { CreateVisitDto } from './dto/create-visit.dto';
import type { ListVisitsQueryDto } from './dto/list-visits.query';

const VISIT_INCLUDE = {
  outlet: { select: { id: true, name: true, customerId: true } },
  agent: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.VisitInclude;

@Injectable()
export class VisitsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(query: ListVisitsQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // SEC-023 (15.3): a SALES_AGENT only ever sees their own visits — this
    // overrides whatever `agentId` they passed, so they can't read another
    // agent's GPS trail by guessing ids. Supervisor roles (SALES_DIRECTOR,
    // OWNER, ...) keep the company-wide view their reports depend on.
    const scopedAgentId = user.roles.includes('SALES_AGENT') ? user.id : query.agentId;
    const where: Prisma.VisitWhereInput = {
      ...(scopedAgentId ? { agentId: scopedAgentId } : {}),
      ...(query.outletId ? { outletId: query.outletId } : {}),
      ...(query.from || query.to
        ? {
            startedAt: {
              ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
              ...(query.to ? { lte: endOfDay(new Date(query.to)) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      tx.visit.findMany({
        where,
        include: VISIT_INCLUDE,
        orderBy: { startedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.visit.count({ where }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // SEC-023: same object-level scoping as list() — another agent's visit id
    // gets the same "not found" as a bad id, rather than leaking that it exists.
    const scopedAgentId = user.roles.includes('SALES_AGENT') ? user.id : undefined;
    const visit = await tx.visit.findFirst({
      where: { id, ...(scopedAgentId ? { agentId: scopedAgentId } : {}) },
      include: VISIT_INCLUDE,
    });
    if (!visit) throw new VisitNotFoundException();
    return visit;
  }

  /**
   * F-M06 / 9.4-follow-up: records a field visit with a hard GPS proximity
   * check against the outlet's registered coordinates (150m radius) — no
   * reason-based bypass. When the outlet has no registered coordinates at
   * all, the check can't run, so `gpsOk` is left `null` (unverifiable, but
   * not the agent's fault) rather than blocking the visit outright.
   * 10.4 offline idempotency: a resubmitted clientId returns the original
   * visit instead of creating a duplicate.
   */
  async create(dto: CreateVisitDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    if (dto.clientId) {
      const existing = await tx.visit.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: VISIT_INCLUDE });
      if (existing) return existing;
    }

    const agentId = user.roles.includes('SALES_AGENT') ? user.id : await this.resolveAgent(tx, dto.agentId);

    const outlet = await tx.outlet.findFirst({ where: { id: dto.outletId, deletedAt: null } });
    if (!outlet) throw new OutletNotFoundException();

    let gpsOk: boolean | null = null;
    if (outlet.latitude != null && outlet.longitude != null) {
      const distance = distanceMeters(dto.latitude, dto.longitude, Number(outlet.latitude), Number(outlet.longitude));
      gpsOk = distance <= VISIT_GPS_RADIUS_M;
      if (!gpsOk) throw new GpsTooFarException(distance);
    }

    let visit;
    try {
      // SAVEPOINT: a P2002 below aborts the whole request transaction at the
      // Postgres level, so without a savepoint the recovery findUnique in the
      // catch block would itself fail instead of finding the winner.
      visit = await withSavepoint(tx, 'visit_create', () =>
        tx.visit.create({
          data: {
            companyId: user.companyId,
            agentId,
            outletId: dto.outletId,
            startedAt: new Date(dto.startedAt),
            endedAt: dto.endedAt ? new Date(dto.endedAt) : null,
            latitude: dto.latitude,
            longitude: dto.longitude,
            gpsOk,
            outcome: dto.outcome,
            noOrderReason: dto.noOrderReason,
            clientId: dto.clientId,
          },
          include: VISIT_INCLUDE,
        }),
      );
    } catch (err) {
      // 10.4: the exact "flaky connection, client retries" scenario clientId
      // exists for — both requests can race past the pre-check above and the
      // loser hits this unique violation. Return the winner's visit.
      if (dto.clientId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await tx.visit.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: VISIT_INCLUDE });
        if (existing) return existing;
      }
      throw err;
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'visit.create',
      entity: 'Visit',
      entityId: visit.id,
      newValue: toAuditJson(visit),
    });

    return visit;
  }

  private async resolveAgent(tx: TenantClient, agentId: string | undefined) {
    if (!agentId) throw new AgentNotFoundException();
    const agent = await tx.user.findFirst({ where: { id: agentId, isActive: true } });
    if (!agent) throw new AgentNotFoundException();
    return agent.id;
  }
}
