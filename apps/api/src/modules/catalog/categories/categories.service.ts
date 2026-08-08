import { Injectable } from '@nestjs/common';
import { Prisma } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { DuplicateCategoryException } from '../catalog-exceptions';
import type { CreateCategoryDto } from './dto/create-category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  list() {
    return this.tenantPrisma.client.productCategory.findMany({ orderBy: { name: 'asc' } });
  }

  async create(dto: CreateCategoryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    // Postgres' unique index treats NULL parentId values as distinct from
    // each other, so it alone doesn't stop two root (parentId: null)
    // categories with the same name — this findFirst does, since Prisma
    // translates `parentId: null` to `IS NULL` here, not `= NULL`.
    const clash = await tx.productCategory.findFirst({
      where: { name: dto.name, parentId: dto.parentId ?? null },
    });
    if (clash) throw new DuplicateCategoryException(dto.name);

    let category;
    try {
      category = await tx.productCategory.create({
        data: { companyId: user.companyId, name: dto.name, parentId: dto.parentId },
      });
    } catch (err) {
      // The findFirst above is only a fast path — @@unique([companyId, name,
      // parentId]) is the real guard against two concurrent creates racing
      // past it for a non-null parentId.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DuplicateCategoryException(dto.name);
      }
      throw err;
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'category.create',
      entity: 'ProductCategory',
      entityId: category.id,
      newValue: toAuditJson(category),
    });

    return category;
  }
}
