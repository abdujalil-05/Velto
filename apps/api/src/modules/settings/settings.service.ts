import { Injectable } from '@nestjs/common';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { isValidTimeZone } from '../analytics/report-utils';
import { CompanyNotFoundException, InvalidTimeZoneException } from './settings-exceptions';
import type { UpdateSettingsDto } from './dto/update-settings.dto';

export type SubscriptionStatus = 'ACTIVE' | 'TRIAL' | 'TRIAL_EXPIRED';

const dayKey = (d: Date, timeZone: string): number => {
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d)
    .split('-')
    .map(Number);
  return Date.UTC(y!, m! - 1, day!) / 86_400_000;
};

/** trialEndsAt null => ACTIVE; instant <= now => TRIAL_EXPIRED; daysLeft = calendar days (company TZ) until the end date. */
export function computeSubscription(plan: string, trialEndsAt: Date | null, timeZone: string, now: Date = new Date()) {
  let status: SubscriptionStatus = 'ACTIVE';
  let daysLeft: number | null = null;
  if (trialEndsAt) {
    const expired = trialEndsAt.getTime() <= now.getTime();
    status = expired ? 'TRIAL_EXPIRED' : 'TRIAL';
    daysLeft = expired ? 0 : Math.max(0, dayKey(trialEndsAt, timeZone) - dayKey(now, timeZone));
  }
  return { plan, trialEndsAt, status, daysLeft };
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async get(companyId: string) {
    const company = await this.loadCompany(companyId);
    return { ...company, subscription: await this.subscriptionOf(company) };
  }

  private async loadCompany(companyId: string) {
    const tx = this.tenantPrisma.client;
    // RLS on Company is `id = current_company_id` (6.10) — this can only
    // ever resolve the caller's own company.
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!company) throw new CompanyNotFoundException();
    return company;
  }

  // ADR-040: informational only (no auto-block); Tenant RLS resolves own tenant only.
  private async subscriptionOf(company: { tenantId: string; timezone: string }) {
    const tenant = await this.tenantPrisma.client.tenant.findUnique({
      where: { id: company.tenantId },
      select: { plan: true, trialEndsAt: true },
    });
    if (!tenant) throw new CompanyNotFoundException();
    return computeSubscription(tenant.plan, tenant.trialEndsAt, company.timezone);
  }

  async update(companyId: string, dto: UpdateSettingsDto, user: AuthenticatedUser) {
    if (dto.timezone !== undefined && !isValidTimeZone(dto.timezone)) throw new InvalidTimeZoneException(dto.timezone);
    const tx = this.tenantPrisma.client;
    const before = await this.loadCompany(companyId);

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
        visitGpsRadiusM: dto.visitGpsRadiusM,
        gpsMaxAccuracyM: dto.gpsMaxAccuracyM,
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

    if (
      before.visitGpsRadiusM !== company.visitGpsRadiusM ||
      before.gpsMaxAccuracyM !== company.gpsMaxAccuracyM
    ) {
      await this.auditLog.log(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: 'company.gps_settings_update',
        entity: 'Company',
        entityId: company.id,
        oldValue: { visitGpsRadiusM: before.visitGpsRadiusM, gpsMaxAccuracyM: before.gpsMaxAccuracyM },
        newValue: { visitGpsRadiusM: company.visitGpsRadiusM, gpsMaxAccuracyM: company.gpsMaxAccuracyM },
      });
    }

    return { ...company, subscription: await this.subscriptionOf(company) };
  }
}
