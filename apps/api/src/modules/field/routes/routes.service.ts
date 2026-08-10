import { Injectable } from '@nestjs/common';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { endOfDay, isoWeekday, startOfDay } from '../../analytics/report-utils';
import { OutletNotFoundException } from '../../customers/customers-exceptions';
// A courier is the same concept in both modules (a User holding COURIER), so
// the exception is defined once, next to its primary caller, rather than
// duplicated here — same cross-module import style as SalesService reusing
// AgentNotFoundException from field-exceptions.
import { CourierNotFoundException } from '../../sales/sales-exceptions';
import {
  AgentNotFoundException,
  RouteNotFoundException,
  RouteNotReadyException,
  RouteNotScheduledTodayException,
} from '../field-exceptions';
import type { CreateRouteDto } from './dto/create-route.dto';
import type { ListRoutesQueryDto } from './dto/list-routes.query';
import type { RouteStopInputDto } from './dto/route-stop-input.dto';
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
    const route = await tx.route.findFirst({
      where: { id },
      include: { ...ROUTE_INCLUDE, runs: { where: { date: startOfDay(new Date()) } } },
    });
    if (!route) throw new RouteNotFoundException();
    return route;
  }

  /**
   * 9.4-follow-up: "marshrutni tugatish" — hard-gated on every stop having a
   * GPS-verified Visit (Visit.gpsOk === true) logged today; no bypass. One
   * RouteRun row per calendar day backs this, since Route itself is a
   * recurring weekly template, not a single dated occurrence.
   */
  async finish(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const route = await tx.route.findFirst({ where: { id }, include: ROUTE_INCLUDE });
    if (!route) throw new RouteNotFoundException();
    if (route.weekday !== isoWeekday(new Date())) throw new RouteNotScheduledTodayException();

    const today = startOfDay(new Date());
    const outletIds = route.stops.map((s) => s.outletId);
    // A courier-served route (`agentId` null) has no GPS-tracked agent to
    // log a Visit in the first place — the "every stop has a verified visit"
    // gate below is agent-route-only in MVP, so it just never finds one
    // finished (falls straight to RouteNotReadyException) rather than
    // querying Visit with a null agentId.
    const verifiedVisits = route.agentId
      ? await tx.visit.findMany({
          where: {
            agentId: route.agentId,
            outletId: { in: outletIds },
            gpsOk: true,
            startedAt: { gte: today, lte: endOfDay(new Date()) },
          },
          select: { outletId: true },
        })
      : [];
    const verifiedOutletIds = new Set(verifiedVisits.map((v) => v.outletId));
    const missingStops = route.stops.filter((s) => !verifiedOutletIds.has(s.outletId));
    if (missingStops.length > 0) {
      throw new RouteNotReadyException(missingStops.map((s) => s.outlet.name));
    }

    const run = await tx.routeRun.upsert({
      where: { routeId_date: { routeId: id, date: today } },
      update: { completedAt: new Date() },
      create: { companyId: user.companyId, routeId: id, date: today, completedAt: new Date() },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'route.finish',
      entity: 'Route',
      entityId: id,
      newValue: toAuditJson(run),
    });

    return run;
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
