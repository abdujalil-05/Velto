import { Injectable } from '@nestjs/common';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { WarehouseNotFoundException } from '../stock-exceptions';
import type { CreateWarehouseDto } from './dto/create-warehouse.dto';

@Injectable()
export class WarehousesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  list() {
    return this.tenantPrisma.client.warehouse.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  async create(dto: CreateWarehouseDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const warehouse = await tx.warehouse.create({
      data: { companyId: user.companyId, name: dto.name, address: dto.address },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'warehouse.create',
      entity: 'Warehouse',
      entityId: warehouse.id,
      newValue: toAuditJson(warehouse),
    });

    return warehouse;
  }

  async assertExists(warehouseId: string) {
    const warehouse = await this.tenantPrisma.client.warehouse.findFirst({ where: { id: warehouseId, isActive: true } });
    if (!warehouse) throw new WarehouseNotFoundException();
    return warehouse;
  }

  /**
   * Every company has exactly one warehouse in this deployment — there's no
   * "create a warehouse" UI, so the first thing that ever needs one (stock
   * receive, product creation's starting-stock field, order creation)
   * provisions it lazily instead of requiring a setup step.
   */
  async getOrCreateDefault() {
    const tx = this.tenantPrisma.client;
    const existing = await tx.warehouse.findFirst({ where: { isActive: true } });
    if (existing) return existing;
    return tx.warehouse.create({
      data: { companyId: this.tenantPrisma.companyId, name: 'Asosiy ombor' },
    });
  }

  async deactivate(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await this.assertExists(id);

    const warehouse = await tx.warehouse.update({ where: { id }, data: { isActive: false } });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'warehouse.deactivate',
      entity: 'Warehouse',
      entityId: id,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(warehouse),
    });

    return warehouse;
  }
}
