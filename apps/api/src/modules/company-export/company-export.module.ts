import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { StorageModule } from '../../common/storage/storage.module';
import { CompanyExportDownloadService } from './company-export-download.service';
import { COMPANY_EXPORT_QUEUE } from './company-export.constants';
import { CompanyExportController } from './company-export.controller';
import { CompanyExportProcessor } from './company-export.processor';
import { CompanyExportService } from './company-export.service';

@Module({
  imports: [BullModule.registerQueue({ name: COMPANY_EXPORT_QUEUE }), StorageModule],
  controllers: [CompanyExportController],
  providers: [CompanyExportService, CompanyExportDownloadService, CompanyExportProcessor, AuditLogService],
})
export class CompanyExportModule {}
