import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { ReportConcurrencyModule } from '../../common/concurrency/report-concurrency.module';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { AgentPerformanceReportService } from './agent-performance.service';
import { DashboardReportGuard } from './dashboard-report.guard';
import { DashboardService } from './dashboard.service';
import { OverviewReportService } from './overview-report.service';
import { ReportExportService } from './report-export-audit.service';
import { ReportsController } from './reports.controller';
import { SalesReportService } from './sales-report.service';

@Module({
  imports: [FinanceModule, ReportConcurrencyModule],
  controllers: [ReportsController],
  providers: [DashboardService, DashboardReportGuard, SalesReportService, AgentPerformanceReportService, OverviewReportService, ReportExportService, AuditLogService],
  exports: [ReportExportService],
})
export class AnalyticsModule {}
