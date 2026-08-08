import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { AgingReportQueryDto } from '../dto/aging-report.query';
import { buildAgingReportExcel } from './aging-report-excel';
import { AgingReportService } from './aging-report.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('reports')
export class AgingReportController {
  constructor(private readonly agingReport: AgingReportService) {}

  @Get('aging')
  @RequirePermission('reports.read')
  aging(@Query() query: AgingReportQueryDto) {
    return this.agingReport.getAging(query);
  }

  // 9.1 "Excel eksport": every indebted customer, not just the current page.
  @Get('aging/export')
  @RequirePermission('reports.read')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="qarzdorlik.xlsx"')
  async agingExport() {
    const rows = await this.agingReport.getAllRows();
    return new StreamableFile(await buildAgingReportExcel(rows));
  }
}
