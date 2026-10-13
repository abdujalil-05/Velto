import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { endOfDay, startOfDay } from '../../analytics/report-utils';
import { OutletNotFoundException } from '../../customers/customers-exceptions';
import {
  AgentNotFoundException,
  VisitNotFoundException,
  VisitSkipReasonRequiredException,
  VisitStartedAtInFutureException,
  VisitStartedAtTooOldException,
} from '../field-exceptions';
import { FieldAlertService } from '../field-alert.service';
import { evaluateGps } from '../geo';
import type { CreateVisitDto } from './dto/create-visit.dto';
import type { ListVisitsQueryDto } from './dto/list-visits.query';

const VISIT_INCLUDE = {
  outlet: { select: { id: true, name: true, customerId: true } },
  agent: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.VisitInclude;

/** Device clocks drift; a startedAt further ahead than this is a wrong clock, not a real visit. */
export const VISIT_FUTURE_SKEW_MS = 5 * 60_000;
export const VISIT_DEFAULT_MAX_AGE_DAYS = 7;

@Injectable()
export class VisitsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly fieldAlerts?: FieldAlertService,
    private readonly config?: ConfigService,
  ) {}

  private get maxAgeDays(): number {
    const raw = Number(this.config?.get('VISIT_STARTED_AT_MAX_AGE_DAYS') ?? VISIT_DEFAULT_MAX_AGE_DAYS);
    return Number.isInteger(raw) && raw >= 1 ? raw : VISIT_DEFAULT_MAX_AGE_DAYS;
  }

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
      ...(query.gpsStatus ? { gpsStatus: query.gpsStatus } : {}),
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
   * F3: records a field visit. GPS problems never block it — the server
   * classifies the client-reported fix via evaluateGps() (precedence in
   * geo.ts), stores the status/distance, and only VERIFIED counts as verified.
   * gpsOk is derived by a DB trigger and never written here.
   * 10.4 offline idempotency: a resubmitted clientId returns the original
   * visit instead of creating a duplicate.
   */
  async create(dto: CreateVisitDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    if (dto.outcome === 'SKIPPED' && !dto.skipReason?.trim()) throw new VisitSkipReasonRequiredException();

    if (dto.clientId) {
      const existing = await tx.visit.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: dto.clientId } }, include: VISIT_INCLUDE });
      if (existing) return existing;
    }

    // Clock-skew guard (after the clientId replay check so an already-accepted
    // visit still resolves to DUPLICATE): REJECTED, never silently clamped.
    const startedAtMs = new Date(dto.startedAt).getTime();
    const now = Date.now();
    if (startedAtMs > now + VISIT_FUTURE_SKEW_MS) throw new VisitStartedAtInFutureException();
    if (startedAtMs < now - this.maxAgeDays * 86_400_000) throw new VisitStartedAtTooOldException(this.maxAgeDays);

    // SEC-023: only OWNER / SALES_DIRECTOR may record a visit on behalf of another user;
    // every other role (SALES_AGENT, COURIER, ...) is forced to their own id.
    const mayDelegate = user.roles.includes('OWNER') || user.roles.includes('SALES_DIRECTOR');
    const agentId = mayDelegate ? await this.resolveAgent(tx, dto.agentId) : user.id;

    const outlet = await tx.outlet.findFirst({ where: { id: dto.outletId, deletedAt: null } });
    if (!outlet) throw new OutletNotFoundException();

    const company = await tx.company.findUniqueOrThrow({
      where: { id: this.tenantPrisma.companyId },
      select: { visitGpsRadiusM: true, gpsMaxAccuracyM: true },
    });
    const gps = evaluateGps({
      permissionDenied: dto.permissionDenied,
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracyM: dto.accuracyM,
      outletLatitude: outlet.latitude == null ? null : Number(outlet.latitude),
      outletLongitude: outlet.longitude == null ? null : Number(outlet.longitude),
      radiusM: company.visitGpsRadiusM,
      maxAccuracyM: company.gpsMaxAccuracyM,
    });

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
            latitude: gps.latitude,
            longitude: gps.longitude,
            gpsStatus: gps.status,
            gpsAccuracyM: gps.latitude == null ? null : dto.accuracyM,
            gpsCapturedAt: gps.latitude == null || !dto.capturedAt ? null : new Date(dto.capturedAt),
            distanceM: gps.distanceM,
            outcome: dto.outcome,
            noOrderReason: dto.noOrderReason,
            skipReason: dto.outcome === 'SKIPPED' ? dto.skipReason?.trim() : null,
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

    this.fieldAlerts?.scheduleGpsUnverified(visit.gpsStatus);
    return visit;
  }

  private async resolveAgent(tx: TenantClient, agentId: string | undefined) {
    if (!agentId) throw new AgentNotFoundException();
    const agent = await tx.user.findFirst({ where: { id: agentId, isActive: true } });
    if (!agent) throw new AgentNotFoundException();
    return agent.id;
  }
}
