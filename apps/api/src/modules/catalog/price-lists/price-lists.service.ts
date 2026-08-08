import { Injectable } from '@nestjs/common';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate, type PaginationQueryDto } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { PriceListNotFoundException, UnknownProductsException } from '../catalog-exceptions';
import type { CreatePriceListDto } from './dto/create-price-list.dto';
import type { UpsertPriceListItemsDto } from './dto/upsert-price-list-items.dto';

@Injectable()
export class PriceListsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(query: PaginationQueryDto) {
    const tx = this.tenantPrisma.client;
    const [data, total] = await Promise.all([
      tx.priceList.findMany({
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.priceList.count(),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  async create(dto: CreatePriceListDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const isDefault = dto.isDefault ?? false;
    if (isDefault) {
      // Exactly one default per tenant — demote the incumbent in the same
      // transaction, otherwise findDefault() picks an arbitrary one.
      await tx.priceList.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }

    const priceList = await tx.priceList.create({
      data: { companyId: user.companyId, name: dto.name, isDefault },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'priceList.create',
      entity: 'PriceList',
      entityId: priceList.id,
      newValue: toAuditJson(priceList),
    });

    return priceList;
  }

  async listItems(priceListId: string, query: PaginationQueryDto) {
    const tx = this.tenantPrisma.client;
    await this.assertExists(priceListId);

    const [data, total] = await Promise.all([
      tx.priceListItem.findMany({
        where: { priceListId },
        include: { product: { select: { id: true, sku: true, name: true, baseUnit: true } } },
        orderBy: { product: { name: 'asc' } },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.priceListItem.count({ where: { priceListId } }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  async upsertItems(priceListId: string, dto: UpsertPriceListItemsDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    await this.assertExists(priceListId);

    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const foundProducts = await tx.product.findMany({
      where: { id: { in: productIds }, deletedAt: null },
      select: { id: true },
    });
    if (foundProducts.length !== productIds.length) {
      const foundIds = new Set(foundProducts.map((p) => p.id));
      throw new UnknownProductsException(productIds.filter((id) => !foundIds.has(id)));
    }

    for (const item of dto.items) {
      await tx.priceListItem.upsert({
        where: { priceListId_productId: { priceListId, productId: item.productId } },
        update: { price: item.price },
        create: { priceListId, productId: item.productId, price: item.price },
      });
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'priceList.items.upsert',
      entity: 'PriceList',
      entityId: priceListId,
      newValue: toAuditJson({ itemCount: dto.items.length }),
    });

    // Bulk saves can exceed the system's max pageSize (7.1: "max 100") — a
    // pageSize sized to fit dto.items.length silently truncated the
    // confirmation response above 100 rows with no signal. Returning a
    // normal first page instead means meta.total/totalPages correctly show
    // there's more, exactly like every other list endpoint; the client can
    // page through GET /:id/items for the rest.
    return this.listItems(priceListId, { page: 1, pageSize: 100 });
  }

  private async assertExists(priceListId: string) {
    const priceList = await this.tenantPrisma.client.priceList.findFirst({ where: { id: priceListId } });
    if (!priceList) throw new PriceListNotFoundException();
    return priceList;
  }

  /**
   * Read-only lookup for callers (product list/detail) that just want to
   * display a price if one happens to exist — never provisions a row, so a
   * plain GET can't have a write side effect.
   */
  findDefault() {
    return this.tenantPrisma.client.priceList.findFirst({ where: { isDefault: true } });
  }

  /**
   * Pricing is a single implicit list now (products carry one "Narxi"
   * field, not a user-managed "Narx ro'yxatlari" module) — this is the one
   * place that price is actually stored (PriceListItem), created lazily the
   * first time a product's price is set rather than during onboarding.
   */
  async getOrCreateDefault() {
    const existing = await this.findDefault();
    if (existing) return existing;
    return this.tenantPrisma.client.priceList.create({
      data: { companyId: this.tenantPrisma.companyId, name: 'Narx', isDefault: true },
    });
  }
}
