import { Throttle } from '@nestjs/throttler';
import { Controller, Get, Header, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { ReportConcurrencyGuard } from '../../../common/concurrency/report-concurrency.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { TenantTx } from '../../../common/tenant/tenant-tx-options.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { REPORT_TX_OPTIONS } from '../../analytics/report-tx.constants';
import { CSV_MIME, XLSX_MIME } from '../../analytics/report-export';
import { ReportExportService } from '../../analytics/report-export-audit.service';
import { AgingAsOfQueryDto, AgingReportQueryDto } from '../dto/aging-report.query';
import { agingReportTable } from './aging-report-table';
import { AgingReportService } from './aging-report.service';

@Controller('reports')
export class AgingReportController {
  constructor(
    private readonly agingReport: AgingReportService,
    private readonly exporter: ReportExportService,
  ) {}

  @Get('aging')
  @UseGuards(ReportConcurrencyGuard)
  @TenantTx(REPORT_TX_OPTIONS)
  @RequirePermission('reports.read')
  aging(@Query() query: AgingReportQueryDto) {
    return this.agingReport.getAging(query);
  }

  // 9.1 "Excel eksport": every indebted customer (not one page), same asOf and
  // rows as the screen (computeRows); reports.export, not reports.read (§7.3).
  @Get('aging/export')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="qarzdorlik.xlsx"')
  async agingExport(@Query() query: AgingAsOfQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = agingReportTable(await this.agingReport.getAllRows(query.asOf), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'aging', 'xlsx', { asOf: query.asOf }, table));
  }

  @Get('aging/export.csv')
  @UseGuards(ReportConcurrencyGuard)
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="qarzdorlik.csv"')
  async agingExportCsv(@Query() query: AgingAsOfQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = agingReportTable(await this.agingReport.getAllRows(query.asOf), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'aging', 'csv', { asOf: query.asOf }, table));
  }
}
