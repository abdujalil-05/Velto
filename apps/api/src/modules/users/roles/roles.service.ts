import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';

/** Read-only per 4.1/5.4: MVP ships with fixed system roles only — custom-role authoring is [v1.1]. */
@Injectable()
export class RolesService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  list() {
    return this.tenantPrisma.client.role.findMany({
      where: { isSystem: true },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
}
