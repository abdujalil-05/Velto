import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate, type PaginationQueryDto } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { SupplierRouteNotFoundException } from '../purchases-exceptions';
import { SuppliersService } from '../suppliers/suppliers.service';
import type { CreateSupplierRouteDto } from './dto/create-supplier-route.dto';
import type { CreateSupplierRouteStopDto } from './dto/create-supplier-route-stop.dto';

const SUPPLIER_ROUTE_INCLUDE = {
  stops: { orderBy: { sequence: 'asc' } },
} satisfies Prisma.SupplierRouteInclude;

/**
 * Recurring supplier pickup routes (schema.prisma `SupplierRoute`/`SupplierRouteStop`,
 * see that model's doc comment for why this is a separate table pair from
 * Route/RouteStop). Mirrors field/routes.service.ts's shape 1:1.
 */
@Injectable()
export class SupplierRoutesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly suppliers: SuppliersService,
  ) {}

  async list(supplierId: string, query: PaginationQueryDto) {
    const tx = this.tenantPrisma.client;
    await this.suppliers.findActiveOrThrow(tx, supplierId);

    const where: Prisma.SupplierRouteWhereInput = { supplierId };
    const [data, total] = await Promise.all([
      tx.supplierRoute.findMany({
        where,
        include: SUPPLIER_ROUTE_INCLUDE,
        orderBy: [{ weekday: 'asc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.supplierRoute.count({ where }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  async create(supplierId: string, dto: CreateSupplierRouteDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    await this.suppliers.findActiveOrThrow(tx, supplierId);

    const route = await tx.supplierRoute.create({
      data: {
        companyId: user.companyId,
        supplierId,
        weekday: dto.weekday,
        name: dto.name,
        isActive: dto.isActive ?? true,
      },
      include: SUPPLIER_ROUTE_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplierRoute.create',
      entity: 'SupplierRoute',
      entityId: route.id,
      newValue: toAuditJson(route),
    });

    return route;
  }

  /** `sequence` is 1-based and derived from the current stop count, same pattern as RouteStop's sortOrder on create. */
  async addStop(supplierId: string, routeId: string, dto: CreateSupplierRouteStopDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    await this.suppliers.findActiveOrThrow(tx, supplierId);

    const route = await tx.supplierRoute.findFirst({ where: { id: routeId, supplierId } });
    if (!route) throw new SupplierRouteNotFoundException();

    const existingStops = await tx.supplierRouteStop.count({ where: { routeId } });
    const stop = await tx.supplierRouteStop.create({
      data: {
        companyId: user.companyId,
        routeId,
        sequence: existingStops + 1,
        pickupAddress: dto.pickupAddress,
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplierRoute.addStop',
      entity: 'SupplierRouteStop',
      entityId: stop.id,
      newValue: toAuditJson(stop),
    });

    return stop;
  }
}
