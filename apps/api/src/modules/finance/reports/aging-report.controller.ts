import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CSV_MIME, renderReport, XLSX_MIME } from '../../analytics/report-export';
import { AgingAsOfQueryDto, AgingReportQueryDto } from '../dto/aging-report.query';
import { agingReportTable } from './aging-report-table';
import { AgingReportService } from './aging-report.service';

@Controller('reports')
export class AgingReportController {
  constructor(private readonly agingReport: AgingReportService) {}

  @Get('aging')
  @RequirePermission('reports.read')
  aging(@Query() query: AgingReportQueryDto) {
    return this.agingReport.getAging(query);
  }

  // 9.1 "Excel eksport": every indebted customer (not one page), same asOf and
  // rows as the screen (computeRows); reports.export, not reports.read (§7.3).
  @Get('aging/export')
  @RequirePermission('reports.export')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="qarzdorlik.xlsx"')
  async agingExport(@Query() query: AgingAsOfQueryDto) {
    return new StreamableFile(await renderReport(agingReportTable(await this.agingReport.getAllRows(query.asOf), new Date()), 'xlsx'));
  }

  @Get('aging/export.csv')
  @RequirePermission('reports.export')
  @Header('Content-Type', CSV_MIME)
  @Header('Content-Disposition', 'attachment; filename="qarzdorlik.csv"')
  async agingExportCsv(@Query() query: AgingAsOfQueryDto) {
    return new StreamableFile(await renderReport(agingReportTable(await this.agingReport.getAllRows(query.asOf), new Date()), 'csv'));
  }
}
