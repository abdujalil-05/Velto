import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AgentPerformanceReportService } from './agent-performance.service';
import { buildAgentPerformanceExcel } from './agent-performance-excel';
import { DashboardService } from './dashboard.service';
import { DateRangeQueryDto } from './dto/date-range.query';
import { OverviewReportService } from './overview-report.service';
import { buildOverviewReportExcel } from './overview-report-excel';
import { SalesReportService } from './sales-report.service';
import { buildSalesReportExcel } from './sales-report-excel';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly salesReport: SalesReportService,
    private readonly agentPerformance: AgentPerformanceReportService,
    private readonly overview: OverviewReportService,
  ) {}

  // 9.3: the home dashboard, not one of the 4 "/reports" tabs — kept on this
  // controller anyway (7.2 lists it as GET /reports/dashboard).
  @Get('dashboard')
  @RequirePermission('reports.read')
  getDashboard() {
    return this.dashboard.getDashboard();
  }

  @Get('sales')
  @RequirePermission('reports.read')
  getSales(@Query() query: DateRangeQueryDto) {
    return this.salesReport.getSalesReport(query);
  }

  // M11 "Excel eksport": same window/filters as the JSON endpoint above.
  @Get('sales/export')
  @RequirePermission('reports.export')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="sotuv-hisoboti.xlsx"')
  async exportSales(@Query() query: DateRangeQueryDto) {
    const report = await this.salesReport.getSalesReport(query);
    return new StreamableFile(await buildSalesReportExcel(report));
  }

  @Get('agents')
  @RequirePermission('reports.read')
  getAgents(@Query() query: DateRangeQueryDto) {
    return this.agentPerformance.getAgentPerformance(query);
  }

  @Get('agents/export')
  @RequirePermission('reports.export')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="agentlar-hisoboti.xlsx"')
  async exportAgents(@Query() query: DateRangeQueryDto) {
    const report = await this.agentPerformance.getAgentPerformance(query);
    return new StreamableFile(await buildAgentPerformanceExcel(report));
  }

  @Get('overview')
  @RequirePermission('reports.read')
  getOverview(@Query() query: DateRangeQueryDto) {
    return this.overview.getOverview(query);
  }

  @Get('overview/export')
  @RequirePermission('reports.export')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="umumiy-hisobot.xlsx"')
  async exportOverview(@Query() query: DateRangeQueryDto) {
    const report = await this.overview.getOverview(query);
    return new StreamableFile(await buildOverviewReportExcel(report));
  }
}
