import { Injectable } from '@nestjs/common';
import { GpsStatus, Prisma, VisitOutcome, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { OutletNotFoundException } from '../../customers/customers-exceptions';
// A courier is the same concept in both modules (a User holding COURIER), so
// the exception is defined once, next to its primary caller, rather than
// duplicated here — same cross-module import style as SalesService reusing
// AgentNotFoundException from field-exceptions.
import { CourierNotFoundException } from '../../sales/sales-exceptions';
import { companyDay } from '../company-day';
import {
  AgentNotFoundException,
  CourierRouteFinishForbiddenException,
  RouteNotFoundException,
  RouteNotOwnedException,
  RouteStopAlreadyClosedException,
  RouteStopNotFoundException,
  type OpenRouteStop,
  RouteNotReadyException,
  RouteNotScheduledTodayException,
} from '../field-exceptions';
import type { CreateRouteDto } from './dto/create-route.dto';
import type { ListRoutesQueryDto } from './dto/list-routes.query';
import type { RouteStopInputDto } from './dto/route-stop-input.dto';
import type { SkipStopDto } from './dto/skip-stop.dto';
import type { UpdateRouteDto } from './dto/update-route.dto';

const ROUTE_INCLUDE = {
  agent: { select: { id: true, firstName: true, lastName: true } },
  courier: { select: { id: true, firstName: true, lastName: true, phone: true } },
  stops: {
    orderBy: { sortOrder: 'asc' },
    include: {
      outlet: { select: { id: true, name: true, address: true, latitude: true, longitude: true, customerId: true } },
    },
  },
} satisfies Prisma.RouteInclude;

@Injectable()
export class RoutesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // 7.2 groups this as "GET /routes/:agentId" — kept here as a query filter
  // instead (`GET /routes?agentId=`) so it stays consistent with how every
  // other list endpoint in this API filters (orders?agentId=, payments?customerId=,
  // ...) rather than colliding with the `GET /routes/:id` detail route.
  async list(query: ListRoutesQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.RouteWhereInput = {
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.courierId ? { courierId: query.courierId } : {}),
      ...(query.weekday ? { weekday: query.weekday } : {}),
    };

    const [data, total] = await Promise.all([
      tx.route.findMany({
        where,
        include: ROUTE_INCLUDE,
        orderBy: [{ weekday: 'asc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.route.count({ where }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const tx = this.tenantPrisma.client;
    const day = await this.today(tx);
    const route = await tx.route.findFirst({
      where: { id },
      include: { ...ROUTE_INCLUDE, runs: { where: { date: day.dbDate } } },
    });
    if (!route) throw new RouteNotFoundException();
    return route;
  }

  /**
   * F3 "marshrutni tugatish". Every stop must be closed today (company
   * timezone) by one of: a VERIFIED visit, a visit at an outlet without
   * coordinates (OUTLET_NO_COORDS), or a SKIPPED visit with a reason —
   * otherwise 409 ROUTE_NOT_READY with `details.openStops`. One RouteRun row
   * per company-local day backs this (Route is a weekly template).
   * Agent-only: courier routes can't be finished (ADR-003a). An agent may
   * finish only their own route (SEC-023); `routes.update` holders (OWNER,
   * SALES_DIRECTOR) may finish any agent route.
   */
  async finish(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const route = await this.loadActionableRoute(tx, id, user);
    const day = await this.today(tx);
    if (route.weekday !== day.isoWeekday) throw new RouteNotScheduledTodayException();

    const closing = await this.closingVisits(tx, route.agentId!, route.stops.map((s) => s.outletId), day);
    const openStops: OpenRouteStop[] = [];
    const noCoordsStops: { outletId: string; outletName: string }[] = [];
    for (const stop of route.stops) {
      const state = closing.get(stop.outletId);
      if (!state) {
        openStops.push({ outletId: stop.outletId, outletName: stop.outlet.name, reason: 'NO_VISIT' });
      } else if (state.closed === 'NO_COORDS') {
        noCoordsStops.push({ outletId: stop.outletId, outletName: stop.outlet.name });
      } else if (state.closed === null) {
        openStops.push({ outletId: stop.outletId, outletName: stop.outlet.name, reason: state.lastStatus });
      }
    }
    if (openStops.length > 0) throw new RouteNotReadyException(openStops);

    const completedAt = new Date();
    const run = await tx.routeRun.upsert({
      where: { routeId_date: { routeId: id, date: day.dbDate } },
      update: { completedAt },
      create: { companyId: user.companyId, routeId: id, date: day.dbDate, completedAt },
    });
    // F3 data-quality: RouteRun has no column for this (schema is another
    // agent's), so it is exposed in the response and recorded in the audit row.
    const result = { ...run, outletNoCoordsCount: noCoordsStops.length, outletNoCoordsStops: noCoordsStops };

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'route.finish',
      entity: 'Route',
      entityId: id,
      newValue: toAuditJson(result),
    });

    return result;
  }

  /** F3: close a stop without a visit — logs a SKIPPED Visit (reason required) for the route's agent. */
  async skipStop(id: string, dto: SkipStopDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const route = await this.loadActionableRoute(tx, id, user);
    const day = await this.today(tx);
    if (route.weekday !== day.isoWeekday) throw new RouteNotScheduledTodayException();
    if (!route.stops.some((s) => s.outletId === dto.outletId)) throw new RouteStopNotFoundException();

    const closing = await this.closingVisits(tx, route.agentId!, [dto.outletId], day);
    if (closing.get(dto.outletId)?.closed) throw new RouteStopAlreadyClosedException();

    const visit = await tx.visit.create({
      data: {
        companyId: user.companyId,
        agentId: route.agentId!,
        outletId: dto.outletId,
        startedAt: new Date(),
        outcome: VisitOutcome.SKIPPED,
        skipReason: dto.reason,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'route.skip_stop',
      entity: 'Route',
      entityId: id,
      newValue: toAuditJson({ visitId: visit.id, outletId: dto.outletId, reason: dto.reason }),
    });

    return visit;
  }

  /** Company-timezone "today" (Company.timezone, default Asia/Tashkent). */
  private async today(tx: TenantClient) {
    const company = await tx.company.findFirst({ select: { timezone: true } });
    return companyDay(new Date(), company?.timezone ?? 'Asia/Tashkent');
  }

  /** Shared guard for finish/skip: 404, courier route -> 403, agent ownership (SEC-023) -> 403. */
  private async loadActionableRoute(tx: TenantClient, id: string, user: AuthenticatedUser) {
    const route = await tx.route.findFirst({ where: { id }, include: ROUTE_INCLUDE });
    if (!route) throw new RouteNotFoundException();
    if (!route.agentId) throw new CourierRouteFinishForbiddenException();
    if (route.agentId !== user.id && !user.permissions.includes('routes.update')) {
      throw new RouteNotOwnedException();
    }
    return route;
  }

  /**
   * Per outlet, today's visits by the route's agent: `closed` is VERIFIED /
   * NO_COORDS / SKIPPED if any visit closes the stop (VERIFIED wins), else
   * null with the latest visit's GpsStatus. Outlets with no visit are absent.
   */
  private async closingVisits(
    tx: TenantClient,
    agentId: string,
    outletIds: string[],
    day: { start: Date; end: Date },
  ) {
    const visits = await tx.visit.findMany({
      where: { agentId, outletId: { in: outletIds }, startedAt: { gte: day.start, lt: day.end } },
      select: { outletId: true, gpsStatus: true, outcome: true },
      orderBy: { startedAt: 'asc' },
    });
    const rank = { VERIFIED: 3, NO_COORDS: 2, SKIPPED: 1 } as const;
    const map = new Map<string, { closed: keyof typeof rank | null; lastStatus: string }>();
    for (const v of visits) {
      const kind: keyof typeof rank | null =
        v.outcome === VisitOutcome.SKIPPED
          ? 'SKIPPED'
          : v.gpsStatus === GpsStatus.VERIFIED
            ? 'VERIFIED'
            : v.gpsStatus === GpsStatus.OUTLET_NO_COORDS
              ? 'NO_COORDS'
              : null;
      const prev = map.get(v.outletId);
      const closed = prev?.closed && (!kind || rank[prev.closed] >= rank[kind]) ? prev.closed : kind;
      map.set(v.outletId, { closed, lastStatus: v.gpsStatus });
    }
    return map;
  }

  async create(dto: CreateRouteDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // CreateRouteDto's ExactlyOneOf decorators already guarantee exactly one
    // of agentId/courierId reaches here — these just turn a bad id into the
    // right 404-ish AppException instead of a raw FK-violation 500.
    if (dto.agentId) await this.assertAgentExists(tx, dto.agentId);
    if (dto.courierId) await this.assertCourierExists(tx, dto.courierId);
    await this.assertOutletsExist(tx, dto.stops);

    const route = await tx.route.create({
      data: {
        companyId: user.companyId,
        agentId: dto.agentId,
        courierId: dto.courierId,
        weekday: dto.weekday,
        name: dto.name,
        stops: { create: dto.stops.map((stop, index) => ({ outletId: stop.outletId, sortOrder: index + 1 })) },
      },
      include: ROUTE_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'route.create',
      entity: 'Route',
      entityId: route.id,
      newValue: toAuditJson(route),
    });

    return route;
  }

  /**
   * 9.2 "tahrirlash, nuqta biriktirish" — `stops`, when given, fully
   * replaces the existing stop list (same pattern as PriceLists.upsertItems).
   *
   * `agentId`/`courierId`: UpdateRouteDto's AtMostOneUuidOf decorators only
   * reject the two arriving *together* in this request — they don't know
   * about the row already in the DB, so reassigning to one explicitly clears
   * the other here (rather than leaving both set, which would violate the
   * DB's `Route_agent_xor_courier_check` CHECK). Omitting both leaves the
   * route's current assignment untouched. Uses the *Unchecked* input (raw
   * scalar FK columns) instead of `agent: {connect/disconnect}` so both
   * columns land in a single UPDATE statement — two separate relation
   * updates would each individually re-check the CHECK constraint against
   * whatever the *other* column still held at that intermediate moment, and
   * fail even on a legitimate reassignment.
   */
  async update(id: string, dto: UpdateRouteDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.route.findFirst({ where: { id }, include: ROUTE_INCLUDE });
    if (!before) throw new RouteNotFoundException();

    if (dto.stops) {
      await this.assertOutletsExist(tx, dto.stops);
      await tx.routeStop.deleteMany({ where: { routeId: id } });
      await tx.routeStop.createMany({
        data: dto.stops.map((stop, index) => ({ routeId: id, outletId: stop.outletId, sortOrder: index + 1 })),
      });
    }

    const data: Prisma.RouteUncheckedUpdateInput = { name: dto.name, weekday: dto.weekday };
    if (dto.agentId) {
      await this.assertAgentExists(tx, dto.agentId);
      data.agentId = dto.agentId;
      data.courierId = null;
    } else if (dto.courierId) {
      await this.assertCourierExists(tx, dto.courierId);
      data.courierId = dto.courierId;
      data.agentId = null;
    }

    const route = await tx.route.update({
      where: { id },
      data,
      include: ROUTE_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'route.update',
      entity: 'Route',
      entityId: id,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(route),
    });

    return route;
  }

  private async assertAgentExists(tx: TenantClient, agentId: string) {
    const agent = await tx.user.findFirst({ where: { id: agentId, isActive: true } });
    if (!agent) throw new AgentNotFoundException();
  }

  /**
   * Stricter than assertAgentExists above: a courier is a User carrying the
   * fixed COURIER system role, and the FK on `Route.courierId` points at
   * `User` generally, so without this role check any user id at all would be
   * accepted as a route's kuryer.
   */
  private async assertCourierExists(tx: TenantClient, courierId: string) {
    const courier = await tx.user.findFirst({
      where: { id: courierId, isActive: true, roles: { some: { role: { code: 'COURIER' } } } },
      select: { id: true },
    });
    if (!courier) throw new CourierNotFoundException();
  }

  private async assertOutletsExist(tx: TenantClient, stops: RouteStopInputDto[]) {
    const unique = [...new Set(stops.map((s) => s.outletId))];
    const found = await tx.outlet.findMany({ where: { id: { in: unique }, deletedAt: null }, select: { id: true } });
    if (found.length !== unique.length) throw new OutletNotFoundException();
  }
}
