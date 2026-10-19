import { Throttle } from '@nestjs/throttler';
import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
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
  @RequirePermission('reports.read')
  aging(@Query() query: AgingReportQueryDto) {
    return this.agingReport.getAging(query);
  }

  // 9.1 "Excel eksport": every indebted customer (not one page), same asOf and
  // rows as the screen (computeRows); reports.export, not reports.read (§7.3).
  @Get('aging/export')
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="qarzdorlik.xlsx"')
  async agingExport(@Query() query: AgingAsOfQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = agingReportTable(await this.agingReport.getAllRows(query.asOf), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'aging', 'xlsx', { asOf: query.asOf }, table));
  }

  @Get('aging/export.csv')
  @RequirePermission('reports.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="qarzdorlik.csv"')
  async agingExportCsv(@Query() query: AgingAsOfQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const table = agingReportTable(await this.agingReport.getAllRows(query.asOf), new Date());
    return new StreamableFile(await this.exporter.exportReport(user, 'aging', 'csv', { asOf: query.asOf }, table));
  }
}
