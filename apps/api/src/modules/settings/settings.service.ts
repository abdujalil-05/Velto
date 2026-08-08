import { Injectable } from '@nestjs/common';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CompanyNotFoundException } from './settings-exceptions';
import type { UpdateSettingsDto } from './dto/update-settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async get(companyId: string) {
    const tx = this.tenantPrisma.client;
    // RLS on Company is `id = current_company_id` (6.10) — this can only
    // ever resolve the caller's own company.
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!company) throw new CompanyNotFoundException();
    return company;
  }

  async update(companyId: string, dto: UpdateSettingsDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await this.get(companyId);

    const company = await tx.company.update({
      where: { id: companyId },
      data: {
        name: dto.name,
        legalName: dto.legalName,
        phone: dto.phone,
        address: dto.address,
        currency: dto.currency,
        defaultVatRate: dto.defaultVatRate,
        docPrefix: dto.docPrefix,
        timezone: dto.timezone,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'company.update',
      entity: 'Company',
      entityId: company.id,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(company),
    });

    return company;
  }
}
