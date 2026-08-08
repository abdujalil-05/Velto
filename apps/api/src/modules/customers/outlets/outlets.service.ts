import { Injectable } from '@nestjs/common';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { CustomerNotFoundException, OutletNotFoundException } from '../customers-exceptions';
import { findOutletLocationDuplicates, type DuplicateWarning } from '../duplicate-detection';
import type { OutletInputDto } from './dto/outlet-input.dto';
import type { UpdateOutletDto } from './dto/update-outlet.dto';

@Injectable()
export class OutletsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(customerId: string) {
    await this.assertCustomerExists(customerId);
    return this.tenantPrisma.client.outlet.findMany({
      where: { customerId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  async create(customerId: string, dto: OutletInputDto, user: AuthenticatedUser): Promise<{ outlet: unknown; warnings: DuplicateWarning[] }> {
    const tx = this.tenantPrisma.client;
    await this.assertCustomerExists(customerId);

    const warnings =
      dto.latitude != null && dto.longitude != null
        ? await findOutletLocationDuplicates(tx, dto.latitude, dto.longitude)
        : [];

    const outlet = await tx.outlet.create({
      data: {
        companyId: user.companyId,
        customerId,
        name: dto.name,
        type: dto.type,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'outlet.create',
      entity: 'Outlet',
      entityId: outlet.id,
      newValue: toAuditJson(outlet),
    });

    return { outlet, warnings };
  }

  async update(customerId: string, outletId: string, dto: UpdateOutletDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.outlet.findFirst({ where: { id: outletId, customerId, deletedAt: null } });
    if (!before) throw new OutletNotFoundException();

    const latitude = dto.latitude ?? (before.latitude ? Number(before.latitude) : undefined);
    const longitude = dto.longitude ?? (before.longitude ? Number(before.longitude) : undefined);
    const warnings =
      (dto.latitude != null || dto.longitude != null) && latitude != null && longitude != null
        ? await findOutletLocationDuplicates(tx, latitude, longitude, outletId)
        : [];

    const outlet = await tx.outlet.update({
      where: { id: outletId },
      data: {
        name: dto.name,
        type: dto.type,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        isActive: dto.isActive,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'outlet.update',
      entity: 'Outlet',
      entityId: outletId,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(outlet),
    });

    return { outlet, warnings };
  }

  async remove(customerId: string, outletId: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.outlet.findFirst({ where: { id: outletId, customerId, deletedAt: null } });
    if (!before) throw new OutletNotFoundException();

    const outlet = await tx.outlet.update({
      where: { id: outletId },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'outlet.delete',
      entity: 'Outlet',
      entityId: outletId,
      oldValue: toAuditJson(before),
    });

    return outlet;
  }

  private async assertCustomerExists(customerId: string) {
    const customer = await this.tenantPrisma.client.customer.findFirst({ where: { id: customerId, deletedAt: null } });
    if (!customer) throw new CustomerNotFoundException();
    return customer;
  }
}
