import { ReportConcurrencyModule } from '../../common/concurrency/report-concurrency.module';
import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingModule } from '../../common/document-numbering/document-numbering.module';
import { ReportExportService } from '../analytics/report-export-audit.service';
import { CustomersModule } from '../customers/customers.module';
import { CashSessionsController } from './cash-sessions/cash-sessions.controller';
import { CashSessionsService } from './cash-sessions/cash-sessions.service';
import { InvoicesController } from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { AgingReportController } from './reports/aging-report.controller';
import { AgingReportService } from './reports/aging-report.service';

@Module({
  imports: [CustomersModule, DocumentNumberingModule, ReportConcurrencyModule],
  controllers: [InvoicesController, PaymentsController, CashSessionsController, AgingReportController],
  providers: [InvoicesService, PaymentsService, CashSessionsService, AgingReportService, AuditLogService, ReportExportService],
  // AgingReportService is reused by the Analytics module for the dashboard's
  // "top 10 qarzdor" list (9.3), per the note in aging-report.service.ts.
  exports: [PaymentsService, AgingReportService],
})
export class FinanceModule {}
