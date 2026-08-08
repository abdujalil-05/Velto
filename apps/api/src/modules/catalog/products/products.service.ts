import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate, resolveSort } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import {
  CategoryNotFoundException,
  DuplicateSkuException,
  InvalidPackagingException,
  PackagingInUseException,
  ProductNotFoundException,
} from '../catalog-exceptions';
import { PriceListsService } from '../price-lists/price-lists.service';
import type { CreateProductDto } from './dto/create-product.dto';
import type { ListProductsQueryDto } from './dto/list-products.query';
import type { PackagingDto } from './dto/packaging.dto';
import type { UpdateProductDto } from './dto/update-product.dto';

const PRODUCT_INCLUDE = { packagings: true, category: true } satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly priceLists: PriceListsService,
  ) {}

  async list(query: ListProductsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { sku: { contains: query.search, mode: 'insensitive' } },
              { barcode: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy = resolveSort<Prisma.ProductOrderByWithRelationInput>(
      query,
      {
        sku: (dir) => ({ sku: dir }),
        name: (dir) => ({ name: dir }),
        brand: (dir) => ({ brand: dir }),
      },
      { name: 'asc' },
    );

    const [data, total] = await Promise.all([
      tx.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.product.count({ where }),
    ]);

    const withPrice = await this.attachPrices(data);
    return paginate(withPrice, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const product = await this.tenantPrisma.client.product.findFirst({
      where: { id, deletedAt: null },
      include: PRODUCT_INCLUDE,
    });
    if (!product) throw new ProductNotFoundException();
    const [withPrice] = await this.attachPrices([product]);
    return withPrice;
  }

  /** Read-only: a plain GET must never provision the default price list. */
  private async attachPrices<T extends { id: string }>(products: T[]): Promise<(T & { price: Prisma.Decimal | null })[]> {
    if (products.length === 0) return [];
    const priceList = await this.priceLists.findDefault();
    if (!priceList) return products.map((p) => ({ ...p, price: null }));

    const items = await this.tenantPrisma.client.priceListItem.findMany({
      where: { priceListId: priceList.id, productId: { in: products.map((p) => p.id) } },
    });
    const priceByProductId = new Map(items.map((i) => [i.productId, i.price]));
    return products.map((p) => ({ ...p, price: priceByProductId.get(p.id) ?? null }));
  }

  private async setPrice(productId: string, price: number) {
    const priceList = await this.priceLists.getOrCreateDefault();
    await this.tenantPrisma.client.priceListItem.upsert({
      where: { priceListId_productId: { priceListId: priceList.id, productId } },
      update: { price },
      create: { priceListId: priceList.id, productId, price },
    });
  }

  async create(dto: CreateProductDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    if (dto.categoryId) {
      const category = await tx.productCategory.findFirst({ where: { id: dto.categoryId } });
      if (!category) throw new CategoryNotFoundException();
    }

    // Matches the partial unique index (soft_delete_partial_unique
    // migration): only a live row with this SKU counts as a clash.
    const clash = await tx.product.findFirst({ where: { sku: dto.sku, deletedAt: null } });
    if (clash) throw new DuplicateSkuException(dto.sku);

    const packagings = normalizePackagings(dto.packagings);

    const product = await tx.product.create({
      data: {
        companyId: user.companyId,
        sku: dto.sku,
        barcode: dto.barcode,
        name: dto.name,
        brand: dto.brand,
        baseUnit: dto.baseUnit,
        categoryId: dto.categoryId,
        vatRate: dto.vatRate ?? 12,
        minPrice: dto.minPrice,
        externalCode: dto.externalCode ?? dto.sku,
        packagings: { create: packagings },
      },
      include: PRODUCT_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'product.create',
      entity: 'Product',
      entityId: product.id,
      newValue: toAuditJson(product),
    });

    if (dto.price !== undefined) {
      await this.setPrice(product.id, dto.price);
      return { ...product, price: new Prisma.Decimal(dto.price) };
    }
    return { ...product, price: null };
  }

  async update(id: string, dto: UpdateProductDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.product.findFirst({ where: { id, deletedAt: null }, include: PRODUCT_INCLUDE });
    if (!before) throw new ProductNotFoundException();

    if (dto.categoryId) {
      const category = await tx.productCategory.findFirst({ where: { id: dto.categoryId } });
      if (!category) throw new CategoryNotFoundException();
    }

    if (dto.sku && dto.sku !== before.sku) {
      const clash = await tx.product.findFirst({ where: { sku: dto.sku, deletedAt: null, NOT: { id } } });
      if (clash) throw new DuplicateSkuException(dto.sku);
    }

    const packagings = dto.packagings ? normalizePackagings(dto.packagings) : undefined;

    let product;
    try {
      product = await tx.product.update({
        where: { id },
        data: {
          sku: dto.sku,
          barcode: dto.barcode,
          name: dto.name,
          brand: dto.brand,
          baseUnit: dto.baseUnit,
          categoryId: dto.categoryId,
          vatRate: dto.vatRate,
          minPrice: dto.minPrice,
          externalCode: dto.externalCode,
          isActive: dto.isActive,
          ...(packagings ? { packagings: { deleteMany: {}, create: packagings } } : {}),
        },
        include: PRODUCT_INCLUDE,
      });
    } catch (err) {
      // packagings: { deleteMany: {} } fails with P2003 (FK RESTRICT) if any
      // of the product's existing packagings is referenced by a
      // SalesOrderLine — surface that as a clean 409 instead of a raw 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new PackagingInUseException();
      }
      throw err;
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'product.update',
      entity: 'Product',
      entityId: product.id,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(product),
    });

    if (dto.price !== undefined) {
      await this.setPrice(product.id, dto.price);
      return { ...product, price: new Prisma.Decimal(dto.price) };
    }
    const [withPrice] = await this.attachPrices([product]);
    return withPrice;
  }

  async softDelete(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new ProductNotFoundException();

    const product = await tx.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'product.delete',
      entity: 'Product',
      entityId: id,
      oldValue: toAuditJson(before),
    });

    return product;
  }

  async setImage(id: string, imageUrl: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await tx.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new ProductNotFoundException();

    const product = await tx.product.update({ where: { id }, data: { imageUrl } });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'product.image.update',
      entity: 'Product',
      entityId: id,
      oldValue: toAuditJson({ imageUrl: before.imageUrl }),
      newValue: toAuditJson({ imageUrl }),
    });

    return product;
  }
}

function normalizePackagings(packagings: PackagingDto[]) {
  const defaults = packagings.filter((p) => p.isDefault);
  if (defaults.length > 1) {
    throw new InvalidPackagingException("Faqat bitta standart qadoq bo'lishi mumkin");
  }
  return packagings.map((p, index) => ({
    name: p.name,
    qtyInBaseUnit: p.qtyInBaseUnit,
    isDefault: defaults.length > 0 ? Boolean(p.isDefault) : index === 0,
  }));
}
