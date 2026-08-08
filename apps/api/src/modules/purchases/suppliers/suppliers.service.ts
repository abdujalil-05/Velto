import { Injectable } from '@nestjs/common';
import { Prisma, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate, resolveSort } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { SupplierNotFoundException } from '../purchases-exceptions';
import type { CreateSupplierDto } from './dto/create-supplier.dto';
import type { ListSuppliersQueryDto } from './dto/list-suppliers.query';
import type { UpdateSupplierDto } from './dto/update-supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(query: ListSuppliersQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy = resolveSort<Prisma.SupplierOrderByWithRelationInput>(
      query,
      {
        name: (dir) => ({ name: dir }),
      },
      { name: 'asc' },
    );

    const [data, total] = await Promise.all([
      tx.supplier.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.supplier.count({ where }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  /**
   * Public for other modules (PurchaseOrders) to validate a supplierId —
   * 11.2 "faqat servis interfeysi orqali". Takes an explicit tx (matching
   * CustomersService.findActiveOrThrow) rather than reading
   * this.tenantPrisma.client ambiently, so it stays composable inside a
   * caller's own transaction/tenant context instead of only working when
   * called from a request that happens to already have one established.
   */
  async findActiveOrThrow(tx: TenantClient, id: string) {
    const supplier = await tx.supplier.findFirst({ where: { id, deletedAt: null } });
    if (!supplier) throw new SupplierNotFoundException();
    return supplier;
  }

  async getById(id: string) {
    return this.findActiveOrThrow(this.tenantPrisma.client, id);
  }

  async create(dto: CreateSupplierDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const supplier = await tx.supplier.create({
      data: { companyId: user.companyId, name: dto.name, phone: dto.phone, address: dto.address },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplier.create',
      entity: 'Supplier',
      entityId: supplier.id,
      newValue: toAuditJson(supplier),
    });

    return supplier;
  }

  async update(id: string, dto: UpdateSupplierDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await this.findActiveOrThrow(tx, id);

    const supplier = await tx.supplier.update({
      where: { id },
      data: { name: dto.name, phone: dto.phone, address: dto.address, isActive: dto.isActive },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplier.update',
      entity: 'Supplier',
      entityId: id,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(supplier),
    });

    return supplier;
  }

  async remove(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await this.findActiveOrThrow(tx, id);

    const supplier = await tx.supplier.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplier.delete',
      entity: 'Supplier',
      entityId: id,
      oldValue: toAuditJson(before),
    });

    return supplier;
  }
}
