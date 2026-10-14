import { Injectable } from '@nestjs/common';
import { AuditLogService, redactAuditJson, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { renderReport, type ReportTable } from './report-export';

export type ReportExportKind = 'sales' | 'agents' | 'overview' | 'aging';
export type ReportExportFormat = 'xlsx' | 'csv';

/**
 * TZ §11.4: every report export is audited (`report.export`) — who, when (createdAt),
 * kind, format, filters/period/asOf and row count. Never file contents or PII.
 * The event is written inside the request transaction only after rendering
 * succeeded, so a failed export rolls back with no success event.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async exportReport(
    user: AuthenticatedUser,
    kind: ReportExportKind,
    format: ReportExportFormat,
    filters: Record<string, string | undefined>,
    table: ReportTable,
  ): Promise<Buffer> {
    const file = await renderReport(table, format);
    const rowCount = table.sections.reduce((sum, s) => sum + s.rows.length, 0);
    await this.auditLog.log(this.tenantPrisma.client, {
      companyId: user.companyId,
      userId: user.id,
      action: 'report.export',
      entity: 'Report',
      entityId: user.companyId,
      newValue: toAuditJson(redactAuditJson({ report: kind, format, filters, rowCount })),
    });
    return file;
  }
}
