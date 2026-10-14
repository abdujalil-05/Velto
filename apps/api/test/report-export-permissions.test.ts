import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { REQUIRE_PERMISSION_KEY } from '../src/common/decorators/require-permission.decorator';
import { ReportsController } from '../src/modules/analytics/reports.controller';
import { AgingReportController } from '../src/modules/finance/reports/aging-report.controller';

describe('F5.4: report export permissions (ADR-003c)', () => {
    const exportRoutes: Array<[unknown, string]> = [
      [ReportsController.prototype.exportSales, 'sales'],
      [ReportsController.prototype.exportSalesCsv, 'sales csv'],
      [ReportsController.prototype.exportAgents, 'agents'],
      [ReportsController.prototype.exportAgentsCsv, 'agents csv'],
      [ReportsController.prototype.exportOverview, 'overview'],
      [ReportsController.prototype.exportOverviewCsv, 'overview csv'],
      [AgingReportController.prototype.agingExport, 'aging'],
      [AgingReportController.prototype.agingExportCsv, 'aging csv'],
    ];

    it('every report export route requires reports.export (aging included), screens require reports.read', () => {
      for (const [handler, name] of exportRoutes) {
        expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler as object), name).toBe('reports.export');
      }
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AgingReportController.prototype.aging)).toBe('reports.read');
    });

    it('SALES_AGENT and CASHIER cannot export; OWNER, SALES_DIRECTOR and ACCOUNTANT can', () => {
      expect(permissionKeysForRole('SALES_AGENT')).not.toContain('reports.export');
      expect(permissionKeysForRole('CASHIER')).not.toContain('reports.export');
      for (const role of ['OWNER', 'SALES_DIRECTOR', 'ACCOUNTANT']) expect(permissionKeysForRole(role)).toContain('reports.export');
    });

    it('ACCOUNTANT stays read/export only: no create/update/delete/reverse/deliver permission', () => {
      const writes = permissionKeysForRole('ACCOUNTANT').filter((k: string) => /\.(create|update|delete|reverse|deliver|receive|adjust|allocate|open|close|finish)$/.test(k));
      expect(writes).toEqual([]);
    });
  });
