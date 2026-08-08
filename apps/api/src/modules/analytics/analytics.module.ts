import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { AgentPerformanceReportService } from './agent-performance.service';
import { DashboardService } from './dashboard.service';
import { OverviewReportService } from './overview-report.service';
import { ReportsController } from './reports.controller';
import { SalesReportService } from './sales-report.service';

@Module({
  imports: [FinanceModule],
  controllers: [ReportsController],
  providers: [DashboardService, SalesReportService, AgentPerformanceReportService, OverviewReportService],
})
export class AnalyticsModule {}
