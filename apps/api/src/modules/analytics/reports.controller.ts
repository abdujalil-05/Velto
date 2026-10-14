import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AgentPerformanceReportService } from './agent-performance.service';
import { DashboardService } from './dashboard.service';
import { DateRangeQueryDto } from './dto/date-range.query';
import { OverviewReportService } from './overview-report.service';
import { CSV_MIME, renderReport, XLSX_MIME } from './report-export';
import { agentPerformanceTable, overviewReportTable, salesReportTable } from './report-tables';
import { SalesReportService } from './sales-report.service';

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

  // TZ §7.3/§16.1: exports reuse the screen's DTO + service call; only the renderer differs.
  @Get('sales/export')
  @RequirePermission('reports.export')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="sotuv-hisoboti.xlsx"')
  async exportSales(@Query() query: DateRangeQueryDto) {
    return new StreamableFile(await renderReport(salesReportTable(await this.salesReport.getSalesReport(query), new Date()), 'xlsx'));
  }

  @Get('sales/export.csv')
  @RequirePermission('reports.export')
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="sotuv-hisoboti.csv"')
  async exportSalesCsv(@Query() query: DateRangeQueryDto) {
    return new StreamableFile(await renderReport(salesReportTable(await this.salesReport.getSalesReport(query), new Date()), 'csv'));
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
    return new StreamableFile(await renderReport(agentPerformanceTable(await this.agentPerformance.getAgentPerformance(query), new Date()), 'xlsx'));
  }

  @Get('agents/export.csv')
  @RequirePermission('reports.export')
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="agentlar-hisoboti.csv"')
  async exportAgentsCsv(@Query() query: DateRangeQueryDto) {
    return new StreamableFile(await renderReport(agentPerformanceTable(await this.agentPerformance.getAgentPerformance(query), new Date()), 'csv'));
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
    return new StreamableFile(await renderReport(overviewReportTable(await this.overview.getOverview(query), new Date()), 'xlsx'));
  }

  @Get('overview/export.csv')
  @RequirePermission('reports.export')
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="umumiy-hisobot.csv"')
  async exportOverviewCsv(@Query() query: DateRangeQueryDto) {
    return new StreamableFile(await renderReport(overviewReportTable(await this.overview.getOverview(query), new Date()), 'csv'));
  }
}
