import { Controller, Get, Header, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantTx } from '../../common/tenant/tenant-tx-options.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ReportConcurrencyGuard } from '../../common/concurrency/report-concurrency.guard';
import { REPORT_RETRY_AFTER_SECONDS, ReportBusyException } from '../../common/concurrency/report-concurrency.limiter';
import { AgentPerformanceReportService } from './agent-performance.service';
import { DashboardService } from './dashboard.service';
import { DateRangeQueryDto } from './dto/date-range.query';
import { OverviewReportService } from './overview-report.service';
import { CSV_MIME, XLSX_MIME } from './report-export';
import { ReportExportService } from './report-export-audit.service';
import { agentPerformanceTable, overviewReportTable, salesReportTable } from './report-tables';
import { REPORT_TX_OPTIONS } from './report-tx.constants';
import { SalesReportService } from './sales-report.service';


@Controller('reports')
export class ReportsController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly salesReport: SalesReportService,
    private readonly agentPerformance: AgentPerformanceReportService,
    private readonly overview: OverviewReportService,
    private readonly exporter: ReportExportService,
  ) {}

  // 9.3: the home dashboard, not one of the 4 "/reports" tabs — kept on this
  // controller anyway (7.2 lists it as GET /reports/dashboard).
  @Get('dashboard')
  @TenantTx({ scope: 'handler' })
  @RequirePermission('reports.read')
  async getDashboard(@Res({ passthrough: true }) res: Response) {
    try {
      return await this.dashboard.getDashboard();
    } catch (e) {
      if (e instanceof ReportBusyException) res.setHeader('Retry-After', String(REPORT_RETRY_AFTER_SECONDS));
      throw e;
    }
  }

  @Get('sales')
  @UseGuards(ReportConcurrencyGuard)
  @TenantTx(REPORT_TX_OPTIONS)
  @RequirePermission('reports.read')
  getSales(@Query() query: DateRangeQueryDto) {
    return this.salesReport.getSalesReport(query);
  }

  // TZ §7.3/§16.1: exports reuse the screen's DTO + service call; only the renderer differs.
  @Get('sales/export')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="sotuv-hisoboti.xlsx"')
  async exportSales(@Query() query: DateRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = salesReportTable(await this.salesReport.getSalesReport(query), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'sales', 'xlsx', { from: query.from, to: query.to }, table));
  }

  @Get('sales/export.csv')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="sotuv-hisoboti.csv"')
  async exportSalesCsv(@Query() query: DateRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = salesReportTable(await this.salesReport.getSalesReport(query), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'sales', 'csv', { from: query.from, to: query.to }, table));
  }

  @Get('agents')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.read')
  getAgents(@Query() query: DateRangeQueryDto) {
    return this.agentPerformance.getAgentPerformance(query);
  }

  @Get('agents/export')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="agentlar-hisoboti.xlsx"')
  async exportAgents(@Query() query: DateRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = agentPerformanceTable(await this.agentPerformance.getAgentPerformance(query), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'agents', 'xlsx', { from: query.from, to: query.to }, table));
  }

  @Get('agents/export.csv')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="agentlar-hisoboti.csv"')
  async exportAgentsCsv(@Query() query: DateRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = agentPerformanceTable(await this.agentPerformance.getAgentPerformance(query), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'agents', 'csv', { from: query.from, to: query.to }, table));
  }

  @Get('overview')
  @UseGuards(ReportConcurrencyGuard)
  @TenantTx(REPORT_TX_OPTIONS)
  @RequirePermission('reports.read')
  getOverview(@Query() query: DateRangeQueryDto) {
    return this.overview.getOverview(query);
  }

  @Get('overview/export')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="umumiy-hisobot.xlsx"')
  async exportOverview(@Query() query: DateRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = overviewReportTable(await this.overview.getOverview(query), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'overview', 'xlsx', { from: query.from, to: query.to }, table));
  }

  @Get('overview/export.csv')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="umumiy-hisobot.csv"')
  async exportOverviewCsv(@Query() query: DateRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = overviewReportTable(await this.overview.getOverview(query), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'overview', 'csv', { from: query.from, to: query.to }, table));
  }
}
